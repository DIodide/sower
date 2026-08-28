import type { Locator, Page } from 'playwright-core';
import type { FillQuestion, FillReportItem } from './sower-client.js';

/**
 * Greenhouse form filler, split so planning stays pure (unit-tested, no
 * browser) and execution alone drives the page. The filler only types and
 * picks options — it NEVER sends the application; the human finishes in
 * the live view, and a colocated test greps this file to keep every
 * send-the-form interaction out of it. That includes the page-level
 * keyboard: an Enter keypress while a form input is focused implicitly
 * sends the form, so every interaction here is locator-scoped.
 */

export interface PlannedSelection {
  value: string;
  /** Resolved from the question's options; null when the value has no match. */
  optionLabel: string | null;
}

export type FillAction =
  | {
      kind: 'text';
      questionId: string;
      label: string;
      matchLabel: string;
      matchIndex: number;
      value: string;
    }
  | {
      kind: 'select';
      questionId: string;
      label: string;
      matchLabel: string;
      matchIndex: number;
      selection: PlannedSelection;
    }
  | {
      kind: 'multiselect';
      questionId: string;
      label: string;
      matchLabel: string;
      matchIndex: number;
      selections: PlannedSelection[];
    }
  | {
      kind: 'skip';
      questionId: string;
      label: string;
      matchLabel: string;
      matchIndex: number;
      detail: string;
    };

/** Trim, collapse whitespace, strip a trailing required marker '*', lowercase. */
export function normalizeLabel(raw: string): string {
  return raw
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\s*\*$/, '')
    .trim()
    .toLowerCase();
}

/**
 * Punctuation- and spacing-insensitive form of a label, used only as a
 * fallback when nothing matches exactly. Question payloads sometimes carry
 * a run-together label for a field the form spaces out ('DisabilityStatus'
 * vs 'Disability Status'), and both collapse to the same key here.
 */
export function looseLabelKey(raw: string): string {
  return normalizeLabel(raw).replace(/[^a-z0-9]/g, '');
}

/**
 * Values headed for a single-line input lose their line breaks: a typed
 * newline is an Enter keystroke (which sends the form), and a one-line
 * field cannot hold them anyway. Textareas keep theirs via fill().
 */
export function stripLineBreaks(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

function toSelection(value: string, question: FillQuestion): PlannedSelection {
  const option = question.options.find((entry) => entry.value === value);
  return { value, optionLabel: option ? option.label : null };
}

/**
 * Pure: questions + resolved values → ordered actions (one per question).
 * Real greenhouse forms repeat labels (EEOC sections legitimately ship
 * identical labels with distinct ids), so every action carries which
 * occurrence of its normalized label it is: the Nth question bearing
 * label L binds to the Nth matching question control in DOM order. Skips
 * count too — the DOM renders a control for every payload question.
 */
export function planFill(questions: FillQuestion[]): FillAction[] {
  const occurrences = new Map<string, number>();
  return questions.map((question) => {
    const matchLabel = normalizeLabel(question.label);
    const matchIndex = occurrences.get(matchLabel) ?? 0;
    occurrences.set(matchLabel, matchIndex + 1);
    const base = {
      questionId: question.id,
      label: question.label,
      matchLabel,
      matchIndex,
    };
    if (question.type === 'file') {
      return {
        kind: 'skip' as const,
        ...base,
        detail: 'attach manually in the live view',
      };
    }
    const values = question.values ?? [];
    const first = values[0];
    if (first === undefined) {
      return { kind: 'skip' as const, ...base, detail: 'no saved answer' };
    }
    if (question.type === 'text' || question.type === 'textarea') {
      const value = values.length === 1 ? first : values.join(', ');
      return { kind: 'text' as const, ...base, value };
    }
    if (question.type === 'select') {
      return {
        kind: 'select' as const,
        ...base,
        selection: toSelection(first, question),
      };
    }
    return {
      kind: 'multiselect' as const,
      ...base,
      selections: values.map((value) => toSelection(value, question)),
    };
  });
}

export interface ExecuteOptions {
  /** Wall-clock budget for the whole form. */
  capMs?: number;
  /** Settle pause after scrolling a control into view. */
  settleMs?: number;
  /** Budget for the board to render its questions before the first action. */
  readyTimeoutMs?: number;
}

const DEFAULT_CAP_MS = 4 * 60_000;
const DEFAULT_SETTLE_MS = 150;
const ACTION_TIMEOUT_MS = 10_000;
const DEFAULT_READY_TIMEOUT_MS = 30_000;
/** Gap between control-count samples while the board is still rendering. */
const FORM_SETTLE_POLL_MS = 300;
/** Pause before the single retry of an action lost to a re-render. */
const TRANSIENT_RETRY_PAUSE_MS = 750;

/** A question control is never a checkbox/radio — those are option inputs. */
const QUESTION_CONTROL_SELECTOR =
  'input:not([type="checkbox"]):not([type="radio"]), textarea, select';

/**
 * Everything that may head a question, in ONE selector so DOM order is
 * preserved across kinds: labels, plus checkbox-group containers headed
 * by a fieldset legend or a [role="group"] aria-labelledby.
 */
const CANDIDATE_ROOT_SELECTOR =
  'label, fieldset:has(legend), [role="group"][aria-labelledby]';

/**
 * Runs every planned action against the live page. Per-question failures
 * become 'failed' outcomes and never abort the rest of the form.
 */
export async function executeFill(
  page: Page,
  actions: FillAction[],
  options: ExecuteOptions = {},
): Promise<FillReportItem[]> {
  const capMs = options.capMs ?? DEFAULT_CAP_MS;
  const settleMs = options.settleMs ?? DEFAULT_SETTLE_MS;
  const readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
  const deadline = Date.now() + capMs;
  await waitForFormReady(page, readyTimeoutMs);
  const scope = await formScope(page);
  const report: FillReportItem[] = [];
  for (const action of actions) {
    if (action.kind === 'skip') {
      report.push({
        questionId: action.questionId,
        label: action.label,
        outcome: 'skipped',
        detail: action.detail,
      });
      continue;
    }
    if (Date.now() > deadline) {
      report.push({
        questionId: action.questionId,
        label: action.label,
        outcome: 'failed',
        detail: 'fill time budget exhausted',
      });
      continue;
    }
    let failure: unknown = null;
    try {
      await fillOne(page, scope, action, settleMs);
    } catch (error) {
      failure = error;
    }
    if (failure !== null && isTransientDomError(failure)) {
      // The board re-rendered under this action. Let it settle and take
      // one more pass before calling the question failed.
      failure = null;
      try {
        await page.waitForTimeout(TRANSIENT_RETRY_PAUSE_MS);
        await waitForFormReady(page, readyTimeoutMs);
        await fillOne(page, scope, action, settleMs);
      } catch (error) {
        failure = error;
      }
    }
    if (failure === null) {
      report.push({
        questionId: action.questionId,
        label: action.label,
        outcome: 'filled',
      });
      continue;
    }
    const detail = (
      failure instanceof Error ? failure.message : String(failure)
    ).slice(0, 500);
    report.push({
      questionId: action.questionId,
      label: action.label,
      outcome: 'failed',
      detail,
    });
  }
  return report;
}

/** Errors that mean 'the DOM moved under us', not 'the field is missing'. */
const TRANSIENT_DOM_ERROR =
  /execution context was destroyed|not attached to the dom|node is detached|frame was detached|element is not attached/i;

export function isTransientDomError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return TRANSIENT_DOM_ERROR.test(message);
}

/**
 * A greenhouse board paints its shell first and renders the questions
 * client-side, so a page that has finished loading often has no controls
 * yet. The first live run typed straight into that gap: the six leading
 * contact fields came back 'no form control labeled ...' and the next one
 * died with 'Execution context was destroyed' as the app swapped the
 * document in, while every question reached later filled fine. So: wait
 * for a real question control to exist, then for the control count to
 * stop growing (the board streams the rest of the form in behind it).
 */
export async function waitForFormReady(
  page: Page,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  await page
    .waitForLoadState('domcontentloaded', { timeout: timeoutMs })
    .catch(() => undefined);
  const controls = page.locator(QUESTION_CONTROL_SELECTOR);
  await controls.first().waitFor({
    state: 'attached',
    timeout: Math.max(1_000, deadline - Date.now()),
  });
  let previous = -1;
  while (Date.now() < deadline) {
    const current = await controls.count();
    if (current === previous) {
      return;
    }
    previous = current;
    await page.waitForTimeout(FORM_SETTLE_POLL_MS);
  }
}

/** Both greenhouse boards (classic and React) render the questions in a form. */
async function formScope(page: Page): Promise<Locator> {
  for (const selector of [
    'form#application_form',
    'form#application-form',
    'form',
  ]) {
    const candidate = page.locator(selector).first();
    if ((await candidate.count()) > 0) {
      return candidate;
    }
  }
  return page.locator('body');
}

interface Located {
  /** Null when the match is a checkbox-group container (no single control). */
  control: Locator | null;
  container: Locator;
}

interface CandidateRoot {
  kind: 'label' | 'group';
  text: string;
  forId: string | null;
  /** Groups only: whether the subtree holds checkbox/radio option inputs. */
  hasOptionInputs: boolean;
}

/** One round-trip: heading text + shape of every candidate root, in DOM order. */
async function scanCandidateRoots(scope: Locator): Promise<CandidateRoot[]> {
  const roots = scope.locator(CANDIDATE_ROOT_SELECTOR);
  return await roots.evaluateAll((elements) =>
    elements.map((element) => {
      if (element.tagName.toLowerCase() === 'label') {
        return {
          kind: 'label' as const,
          text: element.textContent ?? '',
          forId: element.getAttribute('for'),
          hasOptionInputs: false,
        };
      }
      const legend =
        element.tagName.toLowerCase() === 'fieldset'
          ? (element.querySelector(':scope > legend')?.textContent ?? '')
          : '';
      const text =
        legend !== ''
          ? legend
          : (element.getAttribute('aria-labelledby') ?? '')
              .split(/\s+/)
              .filter((id) => id !== '')
              .map(
                (id) =>
                  element.ownerDocument.getElementById(id)?.textContent ?? '',
              )
              .join(' ');
      const hasOptionInputs =
        element.querySelector('input[type="checkbox"], input[type="radio"]') !==
        null;
      return { kind: 'group' as const, text, forId: null, hasOptionInputs };
    }),
  );
}

/**
 * A label is a QUESTION label only when its control (for-id target, a
 * question control inside that target, or a control nested in the label)
 * is an input/textarea/select that is not a checkbox/radio. Checkbox and
 * radio OPTION labels therefore never match a question lookup.
 */
async function locateQuestionControl(
  page: Page,
  label: Locator,
  forId: string | null,
): Promise<Located | null> {
  if (forId !== null && forId !== '') {
    const target = page.locator(`[id="${forId}"]`).first();
    if ((await target.count()) > 0) {
      const shape = await target.evaluate((element) => {
        const tag = element.tagName.toLowerCase();
        if (tag === 'textarea' || tag === 'select') {
          return 'control';
        }
        if (tag === 'input') {
          const type = (element.getAttribute('type') ?? 'text').toLowerCase();
          return type === 'checkbox' || type === 'radio' ? 'option' : 'control';
        }
        return 'container';
      });
      if (shape === 'option') {
        return null;
      }
      if (shape === 'control') {
        return { control: target, container: label.locator('xpath=..') };
      }
      // A wrapper (e.g. a combobox container div) — the question control
      // is the non-checkbox input inside it.
      const inner = target.locator(QUESTION_CONTROL_SELECTOR).first();
      if ((await inner.count()) > 0) {
        return { control: inner, container: label.locator('xpath=..') };
      }
    }
  }
  const nested = label.locator(QUESTION_CONTROL_SELECTOR).first();
  if ((await nested.count()) > 0) {
    return { control: nested, container: label };
  }
  return null;
}

/**
 * Occurrence-indexed, label-bound lookup: the plan's matchIndex picks
 * among duplicate labels in DOM order, so one control never receives two
 * questions' values. Candidates are question labels (locateQuestionControl)
 * and checkbox-group containers whose heading text matches.
 */
async function findControl(
  page: Page,
  scope: Locator,
  matchLabel: string,
  matchIndex: number,
  wants: 'text' | 'options',
): Promise<Located> {
  const roots = scope.locator(CANDIDATE_ROOT_SELECTOR);
  const infos = await scanCandidateRoots(scope);
  // A fieldset legend can repeat the label of a plain input it wraps
  // (greenhouse wraps Phone in <fieldset><legend>Phone</legend> around a
  // country picker plus the number field), and that group would otherwise
  // win the lookup and fail as 'not a text control'. So a text action
  // never binds to a group, and an option action binds only to a group
  // that actually holds option inputs.
  const usable = infos
    .map((info, index) => ({ info, index }))
    .filter(
      ({ info }) =>
        info.kind === 'label' || (wants === 'options' && info.hasOptionInputs),
    );
  let matches = usable.filter(
    ({ info }) => normalizeLabel(info.text) === matchLabel,
  );
  const loose = looseLabelKey(matchLabel);
  if (matches.length === 0 && loose !== '') {
    matches = usable.filter(({ info }) => looseLabelKey(info.text) === loose);
  }
  const located: Located[] = [];
  for (const { info, index } of matches) {
    if (info.kind === 'group') {
      located.push({ control: null, container: roots.nth(index) });
    } else {
      const found = await locateQuestionControl(
        page,
        roots.nth(index),
        info.forId,
      );
      if (found !== null) {
        located.push(found);
      }
    }
    const match = located[matchIndex];
    if (match !== undefined) {
      return match;
    }
  }
  if (located.length === 0) {
    throw new Error(`no form control labeled "${matchLabel}"`);
  }
  throw new Error('duplicate label could not be disambiguated');
}

async function fillOne(
  page: Page,
  scope: Locator,
  action: Exclude<FillAction, { kind: 'skip' }>,
  settleMs: number,
): Promise<void> {
  const { control, container } = await findControl(
    page,
    scope,
    action.matchLabel,
    action.matchIndex,
    action.kind === 'text' ? 'text' : 'options',
  );
  await (control ?? container).scrollIntoViewIfNeeded({
    timeout: ACTION_TIMEOUT_MS,
  });
  await page.waitForTimeout(settleMs);
  if (action.kind === 'text') {
    if (control === null) {
      throw new Error(
        `"${action.label}" is a checkbox group, not a text control`,
      );
    }
    const tag = await control.evaluate((el) => el.tagName.toLowerCase());
    const value =
      tag === 'textarea' ? action.value : stripLineBreaks(action.value);
    await control.fill(value, { timeout: ACTION_TIMEOUT_MS });
    return;
  }
  const selections =
    action.kind === 'select' ? [action.selection] : action.selections;
  if (control === null) {
    // Checkbox group headed by a fieldset legend / [role="group"] label:
    // options are matched inside THIS container only. Zero checkboxes in
    // scope is a failure — never a fall-through to the combobox path.
    await checkByOptionLabel(container, selections);
    return;
  }
  const tag = await control.evaluate((el) => el.tagName.toLowerCase());
  if (tag === 'select') {
    await selectNative(control, selections);
    return;
  }
  for (const selection of selections) {
    await pickComboboxOption(page, control, container, selection, settleMs);
  }
}

/** Native <select>: option value first, its label as the fallback. */
async function selectNative(
  control: Locator,
  selections: PlannedSelection[],
): Promise<void> {
  try {
    await control.selectOption(
      selections.map((selection) => ({ value: selection.value })),
      { timeout: ACTION_TIMEOUT_MS },
    );
  } catch {
    await control.selectOption(
      selections.map((selection) => ({
        label: selection.optionLabel ?? selection.value,
      })),
      { timeout: ACTION_TIMEOUT_MS },
    );
  }
}

/**
 * React-select-style combobox: open, type the option label into the
 * control's own input, then click the matching [role="option"] scoped to
 * THIS control's dropdown. No scoped match is a failure — never a
 * keyboard fallback, because Enter in a focused input sends the form.
 */
async function pickComboboxOption(
  page: Page,
  control: Locator,
  container: Locator,
  selection: PlannedSelection,
  settleMs: number,
): Promise<void> {
  const wanted = selection.optionLabel ?? selection.value;
  const target = normalizeLabel(wanted);
  await control.click({ timeout: ACTION_TIMEOUT_MS });
  const isInput =
    (await control.evaluate((el) => el.tagName.toLowerCase())) === 'input';
  const input = isInput ? control : control.locator('input').first();
  if ((await input.count()) > 0) {
    await input.pressSequentially(stripLineBreaks(wanted), {
      delay: 20,
      timeout: ACTION_TIMEOUT_MS,
    });
  }
  await page.waitForTimeout(Math.max(settleMs, 250));
  const list = await resolveOptionList(page, input, control, container);
  if (list !== null) {
    const options = list.locator('[role="option"]');
    const total = await options.count();
    for (let index = 0; index < total; index++) {
      const option = options.nth(index);
      if (normalizeLabel((await option.textContent()) ?? '') === target) {
        await option.click({ timeout: ACTION_TIMEOUT_MS });
        return;
      }
    }
  }
  throw new Error(`option list did not show '${wanted}'`);
}

/**
 * The dropdown that belongs to THIS control: the element its input (or
 * the control itself) aria-controls/aria-owns points at — portaled menus
 * included — else the first [role="listbox"] inside the question
 * container. Never page-wide: a stale open dropdown from a previous
 * question must not satisfy the match.
 */
async function resolveOptionList(
  page: Page,
  input: Locator,
  control: Locator,
  container: Locator,
): Promise<Locator | null> {
  for (const source of [input, control]) {
    if ((await source.count()) === 0) {
      continue;
    }
    for (const attribute of ['aria-controls', 'aria-owns']) {
      const raw = (await source.getAttribute(attribute)) ?? '';
      for (const id of raw.split(/\s+/).filter((part) => part !== '')) {
        const owned = page.locator(`[id="${id}"]`).first();
        if ((await owned.count()) > 0) {
          return owned;
        }
      }
    }
  }
  const listbox = container.locator('[role="listbox"]').first();
  return (await listbox.count()) > 0 ? listbox : null;
}

/**
 * Checkbox-group multiselect, scoped to the question's own container
 * (fieldset / [role="group"]) — option labels and boxes are looked up in
 * that scope alone. Zero checkboxes in scope is a failure.
 */
async function checkByOptionLabel(
  group: Locator,
  selections: PlannedSelection[],
): Promise<void> {
  if ((await group.locator('input[type="checkbox"]').count()) === 0) {
    throw new Error('no checkboxes in the option group');
  }
  for (const selection of selections) {
    const wanted = normalizeLabel(selection.optionLabel ?? selection.value);
    const labels = group.locator('label');
    const total = await labels.count();
    let done = false;
    for (let index = 0; index < total; index++) {
      const label = labels.nth(index);
      if (normalizeLabel((await label.textContent()) ?? '') !== wanted) {
        continue;
      }
      const forId = await label.getAttribute('for');
      const box = forId
        ? group.locator(`[id="${forId}"]`).first()
        : label.locator('input[type="checkbox"]').first();
      if ((await box.count()) > 0) {
        await box.check({ timeout: ACTION_TIMEOUT_MS });
        done = true;
        break;
      }
    }
    if (!done) {
      throw new Error(
        `no checkbox matches "${selection.optionLabel ?? selection.value}"`,
      );
    }
  }
}
