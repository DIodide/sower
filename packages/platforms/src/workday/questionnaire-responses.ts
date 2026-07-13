import type {
  WorkdayQuestionnaireField,
  WorkdayQuestionOption,
} from './questionnaire.js';

/**
 * Building the Workday calypso `questionnaireResponses` payload and matching
 * our resolved answers to Workday's per-question option GUIDs.
 *
 * The exact wire format is reverse-engineered from a real datasite HAR:
 *   { "questionnaireAnswers": [
 *       { "questionItem": {"id": Q}, "answerText": "5 months" },
 *       { "questionItem": {"id": Q},
 *         "questionMultipleChoiceAnswers": [{"id": OPT, "descriptor": "Yes"}] } ] }
 * Text questions carry `answerText`; choice questions carry the chosen option's
 * GUID (each choice question has its OWN Yes/No GUIDs — not shared), which comes
 * from that field's `options` (attached live by the orchestrator).
 */

/** One resolved questionnaire answer, ready to serialize. */
export type QuestionnaireAnswer =
  | { questionId: string; answerText: string }
  | { questionId: string; choice: WorkdayQuestionOption };

/** The POST body for `.../jobapplication/{jaid}/questionnaireresponses`. */
export function buildQuestionnaireResponses(answers: QuestionnaireAnswer[]): {
  questionnaireAnswers: unknown[];
} {
  return {
    questionnaireAnswers: answers.map((answer) =>
      'answerText' in answer
        ? {
            questionItem: { id: answer.questionId },
            answerText: answer.answerText,
          }
        : {
            questionItem: { id: answer.questionId },
            questionMultipleChoiceAnswers: [
              { id: answer.choice.id, descriptor: answer.choice.descriptor },
            ],
          },
    ),
  };
}

/** Common encodings of the same choice; maps a resolved value to a descriptor. */
const CHOICE_ALIASES: Record<string, string> = {
  true: 'yes',
  false: 'no',
  y: 'yes',
  n: 'no',
};

function normalize(text: string): string {
  return text.trim().toLowerCase();
}

/** Find the option a resolved value selects (by descriptor, alias, or GUID). */
export function matchOption(
  options: WorkdayQuestionOption[],
  value: string,
): WorkdayQuestionOption | undefined {
  const v = normalize(value);
  const target = CHOICE_ALIASES[v] ?? v;
  return options.find(
    (option) => normalize(option.descriptor) === target || option.id === value,
  );
}

/**
 * Map ONE field + its resolved string value to a questionnaire answer, or null
 * when it cannot be answered (empty value, a choice with no matching option, or
 * a non-questionnaire control like file). NEVER guesses — an unmatched choice
 * is skipped for the human, not defaulted.
 */
export function resolveQuestionnaireAnswer(
  field: WorkdayQuestionnaireField,
  value: string,
): QuestionnaireAnswer | null {
  const trimmed = value.trim();
  if (trimmed === '') {
    return null;
  }
  if (field.control === 'text') {
    return { questionId: field.id, answerText: trimmed };
  }
  if (field.control === 'select') {
    const option = matchOption(field.options ?? [], trimmed);
    return option ? { questionId: field.id, choice: option } : null;
  }
  // 'file' is answered via resumeattachments, not questionnaireResponses.
  return null;
}

export interface QuestionnaireResolution {
  /** The POST body to send. */
  payload: { questionnaireAnswers: unknown[] };
  /** Fields left unanswered (no value, no option match, or non-questionnaire). */
  skipped: WorkdayQuestionnaireField[];
  /** Count of skipped fields that were required (visible + required). */
  skippedRequired: number;
}

/**
 * Build the questionnaireResponses payload for a set of fields given a
 * value-by-question-id map (the resolved answers). Fields without a usable
 * answer are reported as skipped — never fabricated.
 */
export function buildQuestionnaireResolution(
  fields: WorkdayQuestionnaireField[],
  valueByQuestionId: Record<string, string | undefined>,
): QuestionnaireResolution {
  const answers: QuestionnaireAnswer[] = [];
  const skipped: WorkdayQuestionnaireField[] = [];
  for (const field of fields) {
    const value = valueByQuestionId[field.id];
    const answer =
      value === undefined ? null : resolveQuestionnaireAnswer(field, value);
    if (answer) {
      answers.push(answer);
    } else {
      skipped.push(field);
    }
  }
  return {
    payload: buildQuestionnaireResponses(answers),
    skipped,
    skippedRequired: skipped.filter((f) => f.required).length,
  };
}
