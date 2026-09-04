import type { Locator, Page } from 'playwright-core';
import {
  type ExecuteOptions,
  type FillAction,
  type FillDriver,
  normalizeLabel,
  type PlannedSelection,
  pickOptionIndex,
  runFill,
  stripLineBreaks,
  type UploadFile,
} from './greenhouse-fill.js';
import type { FillReportItem } from './sower-client.js';

/**
 * The Ashby application form (jobs.ashbyhq.com/<org>/<job>/application).
 *
 * Every question sits in a container carrying the payload's own question
 * id — `[data-field-path="_systemfield_name"]`, `[data-field-path="<uuid>"]`
 * — so lookups bind by id and never by label text. Inside it the widget
 * says what it is:
 *   - text / email / tel / textarea: an input or textarea with that id
 *   - file: a visually hidden input[type=file] with that id
 *   - a two-way question: <button data-option="yes|no" aria-pressed>
 *   - a single choice: .ashby-application-form-input-radio-group-option
 *     rows, each a radio plus its label
 *   - several choices: input[type=checkbox] named by the option's label
 *   - location: input[role=combobox] whose ranked results render in a
 *     page-level [role=listbox]
 *   - a date: a react-datepicker text input that keeps what is typed
 *
 * Nothing here ever sends the form. The only buttons this file clicks are
 * a question's own yes/no pair and a dropdown's options.
 */

const ACTION_TIMEOUT_MS = 10_000;
const OPTION_WAIT_MS = 6_000;
const OPTION_POLL_MS = 150;

const TEXT_CONTROL =
  'input:not([type="file"]):not([type="checkbox"]):not([type="radio"]), textarea';
const RADIO_OPTION = '.ashby-application-form-input-radio-group-option';
const DATE_INPUT =
  'input.ashby-application-form-input-date, .react-datepicker__input-container input';

/** Which of a yes/no pair a selection means; null when it is neither. */
export function booleanChoice(
  selection: PlannedSelection,
): 'yes' | 'no' | null {
  for (const candidate of [selection.optionLabel, selection.value]) {
    const text = normalizeLabel(candidate ?? '');
    if (text === 'true' || text === 'yes') {
      return 'yes';
    }
    if (text === 'false' || text === 'no') {
      return 'no';
    }
  }
  return null;
}

/** The option row whose text is the selection's label (or raw value). */
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

/** Close anything a previous question left open (the location results). */
async function dismissOpenMenus(page: Page): Promise<void> {
  await page.evaluate(`(() => {
    if (document.querySelector('[role="listbox"], .react-datepicker') === null) return;
    for (const type of ['mousedown', 'mouseup', 'click']) {
      document.body.dispatchEvent(
        new MouseEvent(type, { bubbles: true, cancelable: true, view: window }),
      );
    }
  })()`);
}

async function fieldEntry(
  scope: Locator,
  action: Exclude<FillAction, { kind: 'skip' }>,
): Promise<Locator> {
  const entry = scope
    .locator(`[data-field-path="${action.questionId}"]`)
    .first();
  if ((await entry.count()) === 0) {
    throw new Error(`no form control labeled "${action.matchLabel}"`);
  }
  return entry;
}

/**
 * A ranked search (the location field): type, wait for results, take the
 * best one — the top result if it begins with what was typed, else an
 * exact or lone containment match.
 */
async function pickFromSearch(
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
  const options = page.locator('[role="listbox"] [role="option"]');
  const deadline = Date.now() + OPTION_WAIT_MS;
  while ((await options.count()) === 0 && Date.now() < deadline) {
    await page.waitForTimeout(OPTION_POLL_MS);
  }
  const total = await options.count();
  const texts: string[] = [];
  for (let index = 0; index < total; index++) {
    texts.push(normalizeLabel((await options.nth(index).textContent()) ?? ''));
  }
  const index = pickOptionIndex(texts, normalizeLabel(value), {
    topSuggestion: true,
  });
  if (index < 0) {
    throw new Error(`option list did not show '${value}'`);
  }
  await options.nth(index).click({ timeout: ACTION_TIMEOUT_MS });
}

async function fillText(
  page: Page,
  entry: Locator,
  action: Extract<FillAction, { kind: 'text' }>,
): Promise<void> {
  const search = entry.locator('input[role="combobox"]').first();
  if ((await search.count()) > 0) {
    await pickFromSearch(page, search, action.value);
    return;
  }
  const date = entry.locator(DATE_INPUT).first();
  if ((await date.count()) > 0) {
    // react-datepicker keeps a typed date once the field loses focus.
    await date.click({ timeout: ACTION_TIMEOUT_MS });
    await date.fill(stripLineBreaks(action.value), {
      timeout: ACTION_TIMEOUT_MS,
    });
    await date.evaluate((element) => (element as HTMLElement).blur());
    return;
  }
  const control = entry.locator(TEXT_CONTROL).first();
  if ((await control.count()) === 0) {
    throw new Error(`"${action.label}" has no text control`);
  }
  const tag = await control.evaluate((element) =>
    element.tagName.toLowerCase(),
  );
  const value =
    tag === 'textarea' ? action.value : stripLineBreaks(action.value);
  await control.fill(value, { timeout: ACTION_TIMEOUT_MS });
}

async function chooseOne(
  page: Page,
  entry: Locator,
  action: Extract<FillAction, { kind: 'select' }>,
): Promise<void> {
  const yesNo = entry.locator('button[data-option]');
  if ((await yesNo.count()) > 0) {
    const choice = booleanChoice(action.selection);
    if (choice === null) {
      throw new Error(
        `"${action.label}" is a yes/no question; '${action.selection.value}' is neither`,
      );
    }
    await entry
      .locator(`button[data-option="${choice}"]`)
      .first()
      .click({ timeout: ACTION_TIMEOUT_MS });
    return;
  }
  const radios = entry.locator(RADIO_OPTION);
  const radioCount = await radios.count();
  if (radioCount > 0) {
    for (let index = 0; index < radioCount; index++) {
      const row = radios.nth(index);
      const text = (await row.locator('label').first().textContent()) ?? '';
      if (optionMatches(text, action.selection)) {
        await row
          .locator('label')
          .first()
          .click({ timeout: ACTION_TIMEOUT_MS });
        return;
      }
    }
    throw new Error(
      `option list did not show '${action.selection.optionLabel ?? action.selection.value}'`,
    );
  }
  const native = entry.locator('select').first();
  if ((await native.count()) > 0) {
    await native.selectOption(
      { label: action.selection.optionLabel ?? action.selection.value },
      { timeout: ACTION_TIMEOUT_MS },
    );
    return;
  }
  const search = entry.locator('[role="combobox"]').first();
  if ((await search.count()) > 0) {
    await pickFromSearch(
      page,
      search,
      action.selection.optionLabel ?? action.selection.value,
    );
    return;
  }
  throw new Error(`"${action.label}" has no choice control`);
}

async function chooseMany(
  entry: Locator,
  action: Extract<FillAction, { kind: 'multiselect' }>,
): Promise<void> {
  const boxes = entry.locator('input[type="checkbox"]');
  const total = await boxes.count();
  if (total === 0) {
    throw new Error(`"${action.label}" has no checkboxes`);
  }
  for (const selection of action.selections) {
    let done = false;
    for (let index = 0; index < total; index++) {
      const box = boxes.nth(index);
      const name = (await box.getAttribute('name')) ?? '';
      const labelText =
        (await box
          .locator('xpath=ancestor::*[1]//label')
          .first()
          .textContent()
          .catch(() => null)) ?? '';
      if (
        optionMatches(name, selection) ||
        optionMatches(labelText, selection)
      ) {
        await box.check({ timeout: ACTION_TIMEOUT_MS, force: true });
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
  await dismissOpenMenus(page);
  const entry = await fieldEntry(scope, action);
  await entry.scrollIntoViewIfNeeded({ timeout: ACTION_TIMEOUT_MS });
  await page.waitForTimeout(settleMs);
  switch (action.kind) {
    case 'file': {
      const file = files.get(action.questionId);
      if (file === undefined) {
        throw new Error('document was not downloaded');
      }
      if ('error' in file) {
        throw new Error(file.error);
      }
      await entry
        .locator('input[type="file"]')
        .first()
        .setInputFiles(
          { name: file.name, mimeType: file.mimeType, buffer: file.buffer },
          { timeout: ACTION_TIMEOUT_MS },
        );
      return;
    }
    case 'text':
      await fillText(page, entry, action);
      return;
    case 'select':
      await chooseOne(page, entry, action);
      return;
    case 'multiselect':
      await chooseMany(entry, action);
      return;
  }
}

const driver: FillDriver = {
  scope: async (page) => page.locator('body'),
  fillOne,
};

/** Run every planned action against a live Ashby application form. */
export async function executeAshbyFill(
  page: Page,
  actions: FillAction[],
  options: ExecuteOptions = {},
): Promise<FillReportItem[]> {
  return await runFill(page, actions, options, driver);
}
