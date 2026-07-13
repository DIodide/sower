import type { Question, ResolvedAnswer } from '@sower/core';

/**
 * A single form-fill action the driver performs against ONE Workday control.
 * The plan is data, so the never-invent guarantee is testable without a
 * browser: buildFillPlan only ever emits actions for questions that have a
 * resolved answer, and the value carried is EXACTLY the resolved value.
 */
export type FillAction =
  | { kind: 'text'; questionId: string; label: string; value: string }
  | { kind: 'select'; questionId: string; label: string; optionValue: string }
  | {
      kind: 'multiselect';
      questionId: string;
      label: string;
      optionValues: string[];
    }
  | {
      kind: 'file';
      questionId: string;
      label: string;
      storagePath: string;
    };

export interface FillPlan {
  actions: FillAction[];
  /**
   * Questions with NO resolved answer — left blank on the form and surfaced
   * to the human reviewer. Split into required/optional for the caller.
   */
  skipped: Question[];
  skippedRequired: number;
}

/** Index resolved answers by question id (last write wins, defensively). */
function indexAnswers(answers: ResolvedAnswer[]): Map<string, ResolvedAnswer> {
  const byId = new Map<string, ResolvedAnswer>();
  for (const answer of answers) {
    byId.set(answer.questionId, answer);
  }
  return byId;
}

/** Coerce a resolved scalar to the string a text field receives. */
function asText(value: ResolvedAnswer['value']): string | null {
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) {
    // A multi-value answer typed into a single text field is not meaningful;
    // decline rather than guess a join.
    return null;
  }
  return null;
}

/**
 * Build the ordered fill plan for a Workday questionnaire page.
 *
 * GUARDRAIL (never invent): an action is emitted for a question ONLY when a
 * resolved answer exists for it, and the action carries that answer verbatim.
 * A question with no answer — or whose answer shape does not fit the control
 * (e.g. an array for a text box, a select value not among the options) — is
 * SKIPPED, left blank for the human. Nothing is ever fabricated or coerced
 * into a guess.
 *
 * Select/multiselect actions additionally require the resolved value(s) to
 * match one of the question's option values; a non-matching value is dropped
 * (the resolver already guards this, but the plan re-checks so a mismatch can
 * never be typed into the DOM).
 */
export function buildFillPlan(
  questions: Question[],
  answers: ResolvedAnswer[],
): FillPlan {
  const byId = indexAnswers(answers);
  const actions: FillAction[] = [];
  const skipped: Question[] = [];

  for (const question of questions) {
    const answer = byId.get(question.id);
    const action =
      answer && answer.value !== null ? actionFor(question, answer) : null;
    if (action) {
      actions.push(action);
    } else {
      skipped.push(question);
    }
  }

  return {
    actions,
    skipped,
    skippedRequired: skipped.filter((q) => q.required).length,
  };
}

function optionValueSet(question: Question): Set<string> {
  return new Set((question.options ?? []).map((o) => String(o.value)));
}

function actionFor(
  question: Question,
  answer: ResolvedAnswer,
): FillAction | null {
  switch (question.type) {
    case 'text':
    case 'textarea': {
      const value = asText(answer.value);
      return value === null
        ? null
        : {
            kind: 'text',
            questionId: question.id,
            label: question.label,
            value,
          };
    }
    case 'select': {
      const value = asText(answer.value);
      if (value === null) {
        return null;
      }
      // Only fill a value the control actually offers.
      if (!optionValueSet(question).has(value)) {
        return null;
      }
      return {
        kind: 'select',
        questionId: question.id,
        label: question.label,
        optionValue: value,
      };
    }
    case 'multiselect': {
      const values = Array.isArray(answer.value)
        ? answer.value
        : typeof answer.value === 'string'
          ? [answer.value]
          : [];
      const allowed = optionValueSet(question);
      const matched = values.filter((v) => allowed.has(v));
      return matched.length === 0
        ? null
        : {
            kind: 'multiselect',
            questionId: question.id,
            label: question.label,
            optionValues: matched,
          };
    }
    case 'file': {
      const storagePath = asText(answer.value);
      // A file answer's value is the vault storage path (source 'document').
      return storagePath === null || answer.source !== 'document'
        ? null
        : {
            kind: 'file',
            questionId: question.id,
            label: question.label,
            storagePath,
          };
    }
    default:
      return null;
  }
}
