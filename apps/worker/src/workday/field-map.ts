import type { Question, QuestionOption } from '@sower/core';

/**
 * A form control as scraped from a live Workday questionnaire page. The
 * Playwright driver produces these from the DOM; field-map turns them into
 * the platform-neutral `Question` the answer resolver understands. Keeping
 * the mapping pure makes it unit-testable without a browser.
 */
export interface RawField {
  /** The control's data-automation-id (stable within a questionnaire). */
  automationId: string;
  /** Visible label text (from <label>, aria-label, or the field group). */
  label: string;
  /** The kind of control, as recognized by the scraper. */
  control:
    | 'text'
    | 'textarea'
    | 'select'
    | 'multiselect'
    | 'radio'
    | 'checkbox'
    | 'date'
    | 'file'
    | 'unknown';
  required: boolean;
  /** Options for select/multiselect/radio controls. */
  options?: { label: string; value: string }[];
}

const YES_NO_OPTIONS: QuestionOption[] = [
  { label: 'Yes', value: 'true' },
  { label: 'No', value: 'false' },
];

/**
 * Automation-ids that are NEVER answerable form fields: Workday's `beecatcher`
 * is a bot honeypot (a hidden text input a human never fills). Scraping it and
 * filling it would flag the application as a bot, so it is dropped outright —
 * belt-and-suspenders alongside the resolver never producing a value for it.
 */
const HONEYPOT_IDS = new Set(['beecatcher']);

function toOptions(
  raw: { label: string; value: string }[] | undefined,
): QuestionOption[] {
  return (raw ?? [])
    .map((option) => ({
      label: option.label.trim(),
      value: option.value,
    }))
    .filter((option) => option.label.length > 0);
}

/**
 * Map a scraped Workday control to a `Question`, or null when it carries no
 * answerable content (an empty label, or an option-less select we could not
 * read). Type mapping:
 * - text/date    -> 'text'      (dates are typed as text; the resolver's
 *                                 profile values are ISO-ish strings)
 * - textarea     -> 'textarea'
 * - select/radio -> 'select'    (single choice; options preserved so the
 *                                 resolver's option-matching guard applies)
 * - multiselect  -> 'multiselect'
 * - checkbox     -> 'select' with Yes/No options (a lone consent/boolean box)
 * - file         -> 'file'
 * - unknown      -> 'select' when it has options (keeps option-matching
 *                    protection), else 'text'
 */
export function rawFieldToQuestion(raw: RawField): Question | null {
  const label = raw.label.trim();
  if (
    label.length === 0 ||
    raw.automationId.length === 0 ||
    HONEYPOT_IDS.has(raw.automationId)
  ) {
    return null;
  }

  const options = toOptions(raw.options);

  let type: Question['type'];
  let questionOptions: QuestionOption[] | undefined;
  switch (raw.control) {
    case 'textarea':
      type = 'textarea';
      break;
    case 'text':
    case 'date':
      type = 'text';
      break;
    case 'select':
    case 'radio':
      type = 'select';
      questionOptions = options;
      break;
    case 'multiselect':
      type = 'multiselect';
      questionOptions = options;
      break;
    case 'checkbox':
      // A lone checkbox is a boolean; model it as a Yes/No select so the
      // resolver's boolean-yes/no strategy and option guard both apply.
      type = 'select';
      questionOptions = YES_NO_OPTIONS;
      break;
    case 'file':
      type = 'file';
      break;
    default:
      // Unknown control with options stays a guarded select; otherwise free
      // text. Mirrors the greenhouse adapter's degrade rule.
      type = options.length > 0 ? 'select' : 'text';
      if (options.length > 0) {
        questionOptions = options;
      }
  }

  // A select/multiselect with no readable options can't be answered safely
  // (the resolver's option guard would reject everything) — drop it so it is
  // surfaced as human-needed rather than silently unanswerable.
  if (
    (type === 'select' || type === 'multiselect') &&
    (!questionOptions || questionOptions.length === 0)
  ) {
    return null;
  }

  const question: Question = {
    id: raw.automationId,
    label,
    type,
    required: raw.required,
  };
  if (questionOptions && questionOptions.length > 0) {
    question.options = questionOptions;
  }
  return question;
}

/**
 * Map many scraped fields to Questions, dropping unanswerable ones and
 * de-duplicating by automation-id (Workday occasionally renders a hidden
 * mirror of a control; the first visible wins).
 */
export function rawFieldsToQuestions(fields: RawField[]): Question[] {
  const seen = new Set<string>();
  const questions: Question[] = [];
  for (const field of fields) {
    if (seen.has(field.automationId)) {
      continue;
    }
    const question = rawFieldToQuestion(field);
    if (question) {
      seen.add(field.automationId);
      questions.push(question);
    }
  }
  return questions;
}
