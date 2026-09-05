import type { Locator, Page } from 'playwright-core';
import {
  type ExecuteOptions,
  type FillAction,
  type FillDriver,
  normalizeLabel,
  type PlannedSelection,
  runFill,
  stripLineBreaks,
  type UploadFile,
} from './greenhouse-fill.js';
import type { FillReportItem } from './sower-client.js';

/**
 * The Lever application form (jobs.lever.co/<org>/<posting>/apply).
 *
 * A classic server-rendered form: every control carries a `name` that is
 * the payload's own question id — `name`, `email`, `urls[LinkedIn]`,
 * `cards[<card>][field0]` — so lookups bind by name and never by label
 * text. The widget then says what it is:
 *   - text / email / tel / url / textarea: the control with that name
 *   - resume: input[type=file] with that name; Lever parses the file and
 *     writes what it reads into the name/email fields for a moment, so
 *     the upload goes first and the fill pauses before typing over it
 *   - a single choice: input[type=radio] per option, the option's text as
 *     its value; several choices: input[type=checkbox] likewise
 *   - a dropdown: a native <select>
 *   - location: a text input whose typed value only counts once a row of
 *     its own results is picked (that fills the hidden selectedLocation)
 *
 * The EEO block lives outside the question cards and is left to the human
 * by the adapter's design. Nothing here ever sends the form: the only
 * clicks are a radio's label and a location result.
 */

const ACTION_TIMEOUT_MS = 10_000;
const OPTION_WAIT_MS = 6_000;
const OPTION_POLL_MS = 150;
/** Lever reads an uploaded resume and fills fields from it; let it finish. */
const RESUME_PARSE_PAUSE_MS = 4_000;

/** A name attribute selector; the ids carry brackets, which quoting keeps. */
function byName(id: string, suffix = ''): string {
  return `[name="${id.replace(/["\\]/g, '\\$&')}"]${suffix}`;
}

/** The option row whose value or text is the selection's label or value. */
export function optionMatches(
  text: string,
  selection: PlannedSelection,
): boolean {
  const normalized = normalizeLabel(text);
  return [selection.optionLabel, selection.value].some(
    (candidate) =>
      candidate !== null && normalizeLabel(candidate) === normalized,
  );
}

/**
 * Lever's location field: the typed text is only a query; the answer is
 * the result row that gets picked. Rows are ranked, so the top row is
 * taken when it begins with the typed city.
 */
async function pickLocation(
  page: Page,
  input: Locator,
  value: string,
): Promise<void> {
  await input.click({ timeout: ACTION_TIMEOUT_MS });
  await input.fill('');
  await input.pressSequentially(stripLineBreaks(value), {
    delay: 20,
    timeout: ACTION_TIMEOUT_MS,
  });
  const rows = page.locator('.dropdown-results > *');
  // Lever's geocoder answers in its own time and occasionally not at all
  // for a first query; a second, retyped query usually gets an answer.
  for (let attempt = 0; attempt < 2 && (await rows.count()) === 0; attempt++) {
    if (attempt > 0) {
      await input.fill('');
      await input.pressSequentially(stripLineBreaks(value), {
        delay: 40,
        timeout: ACTION_TIMEOUT_MS,
      });
    }
    const deadline = Date.now() + OPTION_WAIT_MS;
    while ((await rows.count()) === 0 && Date.now() < deadline) {
      await page.waitForTimeout(OPTION_POLL_MS);
    }
  }
  const total = await rows.count();
  if (total === 0) {
    throw new Error(`option list did not show '${value}'`);
  }
  const city = normalizeLabel(value.split(',')[0] ?? '');
  for (let index = 0; index < total; index++) {
    const text = normalizeLabel((await rows.nth(index).textContent()) ?? '');
    if (
      text === normalizeLabel(value) ||
      (city !== '' && text.startsWith(city))
    ) {
      await rows.nth(index).click({ timeout: ACTION_TIMEOUT_MS });
      return;
    }
  }
  throw new Error(`option list did not show '${value}'`);
}

/** The text control with the question's name: an input or a textarea. */
function textControl(scope: Locator, questionId: string): Locator {
  const name = byName(questionId);
  return scope
    .locator(
      `input${name}:not([type="file"]):not([type="checkbox"]):not([type="radio"]):not([type="hidden"]), textarea${name}`,
    )
    .first();
}

async function fillText(
  page: Page,
  scope: Locator,
  action: Extract<FillAction, { kind: 'text' }>,
): Promise<void> {
  const target = textControl(scope, action.questionId);
  if ((await target.count()) === 0) {
    throw new Error(`no form control labeled "${action.matchLabel}"`);
  }
  if (action.questionId === 'location') {
    await pickLocation(page, target, action.value);
    return;
  }
  const tag = await target.evaluate((element) => element.tagName.toLowerCase());
  const value =
    tag === 'textarea' ? action.value : stripLineBreaks(action.value);
  await target.fill(value, { timeout: ACTION_TIMEOUT_MS });
}

async function chooseOne(
  scope: Locator,
  action: Extract<FillAction, { kind: 'select' }>,
): Promise<void> {
  const native = scope.locator(`select${byName(action.questionId)}`).first();
  if ((await native.count()) > 0) {
    const wanted = action.selection;
    const values = await native.locator('option').evaluateAll((options) =>
      options.map((option) => ({
        value: (option as HTMLOptionElement).value,
        label: option.textContent ?? '',
      })),
    );
    const hit = values.find(
      (option) =>
        optionMatches(option.value, wanted) ||
        optionMatches(option.label, wanted),
    );
    if (hit === undefined) {
      throw new Error(
        `option list did not show '${wanted.optionLabel ?? wanted.value}'`,
      );
    }
    await native.selectOption(
      { value: hit.value },
      { timeout: ACTION_TIMEOUT_MS },
    );
    return;
  }
  const radios = scope.locator(
    `input[type="radio"]${byName(action.questionId)}`,
  );
  const total = await radios.count();
  if (total === 0) {
    throw new Error(`no form control labeled "${action.matchLabel}"`);
  }
  for (let index = 0; index < total; index++) {
    const radio = radios.nth(index);
    const value = (await radio.getAttribute('value')) ?? '';
    const text = (await radio.locator('xpath=..').textContent()) ?? '';
    if (
      optionMatches(value, action.selection) ||
      optionMatches(text, action.selection)
    ) {
      // The radio hides behind a styled label; clicking the label is what a
      // person does, and it toggles the input.
      await radio.locator('xpath=..').click({ timeout: ACTION_TIMEOUT_MS });
      return;
    }
  }
  throw new Error(
    `option list did not show '${action.selection.optionLabel ?? action.selection.value}'`,
  );
}

async function chooseMany(
  scope: Locator,
  action: Extract<FillAction, { kind: 'multiselect' }>,
): Promise<void> {
  const boxes = scope.locator(
    `input[type="checkbox"]${byName(action.questionId)}`,
  );
  const total = await boxes.count();
  if (total === 0) {
    throw new Error(`no form control labeled "${action.matchLabel}"`);
  }
  for (const selection of action.selections) {
    let done = false;
    for (let index = 0; index < total; index++) {
      const box = boxes.nth(index);
      const value = (await box.getAttribute('value')) ?? '';
      const text = (await box.locator('xpath=..').textContent()) ?? '';
      if (optionMatches(value, selection) || optionMatches(text, selection)) {
        if (!(await box.isChecked())) {
          await box.locator('xpath=..').click({ timeout: ACTION_TIMEOUT_MS });
        }
        done = true;
        break;
      }
    }
    if (!done) {
      throw new Error(
        `option list did not show '${selection.optionLabel ?? selection.value}'`,
      );
    }
  }
}

async function fillOne(
  page: Page,
  scope: Locator,
  action: Exclude<FillAction, { kind: 'skip' }>,
  settleMs: number,
  files: ReadonlyMap<string, UploadFile | { error: string }>,
): Promise<void> {
  switch (action.kind) {
    case 'file': {
      const input = scope
        .locator(`input[type="file"]${byName(action.questionId)}`)
        .first();
      if ((await input.count()) === 0) {
        throw new Error(`no form control labeled "${action.matchLabel}"`);
      }
      const file = files.get(action.questionId);
      if (file === undefined) {
        throw new Error('document was not downloaded');
      }
      if ('error' in file) {
        throw new Error(file.error);
      }
      await input.setInputFiles(
        { name: file.name, mimeType: file.mimeType, buffer: file.buffer },
        { timeout: ACTION_TIMEOUT_MS },
      );
      if (action.questionId === 'resume') {
        await page.waitForTimeout(RESUME_PARSE_PAUSE_MS);
      }
      return;
    }
    case 'text': {
      const anchor = scope.locator(byName(action.questionId)).first();
      if ((await anchor.count()) > 0) {
        await anchor.scrollIntoViewIfNeeded({ timeout: ACTION_TIMEOUT_MS });
        await page.waitForTimeout(settleMs);
      }
      await fillText(page, scope, action);
      return;
    }
    case 'select': {
      const anchor = scope.locator(byName(action.questionId)).first();
      if ((await anchor.count()) > 0) {
        await anchor.scrollIntoViewIfNeeded({ timeout: ACTION_TIMEOUT_MS });
        await page.waitForTimeout(settleMs);
      }
      await chooseOne(scope, action);
      return;
    }
    case 'multiselect': {
      const anchor = scope.locator(byName(action.questionId)).first();
      if ((await anchor.count()) > 0) {
        await anchor.scrollIntoViewIfNeeded({ timeout: ACTION_TIMEOUT_MS });
        await page.waitForTimeout(settleMs);
      }
      await chooseMany(scope, action);
      return;
    }
  }
}

const driver: FillDriver = {
  scope: async (page) => {
    const form = page.locator('form#application-form').first();
    return (await form.count()) > 0 ? form : page.locator('body');
  },
  fillOne,
};

/** Run every planned action against a live Lever application form. */
export async function executeLeverFill(
  page: Page,
  actions: FillAction[],
  options: ExecuteOptions = {},
): Promise<FillReportItem[]> {
  return await runFill(page, actions, options, driver);
}
