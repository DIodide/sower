import type { Question } from '@sower/core';
import { htmlEntityEncodedToPlainText } from '../description.js';

/**
 * Parser for a Workday "calypso" questionnaire definition — the JSON returned
 * by `POST /wday/calypso/cxs/common/{tenant}/questionnaire/{id}/definition`.
 *
 * The definition is a JSON Schema: `definitions.primaryQuestionnaire` holds a
 * `properties` map keyed by question GUID plus a `required` list. Each property
 * carries `label` (HTML), `type`, `order`, `hidden`, `readOnly`. This is the
 * authenticated view of the questions the PUBLIC cxs API withholds — reading it
 * needs a candidate session (see workday-calypso-api.md).
 *
 * Reverse-engineered from a real datasite application (fixture
 * fixture-questionnaire-definition.json), verified live 2026-07-12.
 */

/** A raw question field as declared in the definition schema. */
export interface WorkdayQuestionnaireField {
  /** The question GUID (used as the answer key in questionnaireresponses). */
  id: string;
  /** Plain-text question label (HTML stripped). */
  label: string;
  /**
   * Normalized control kind:
   * - 'text'   <- schema type 'string' / 'integer' / 'number'
   * - 'select' <- schema type 'object' / 'boolean' (a choice; the option
   *               values are NOT inline — the client resolves them separately)
   * - 'file'   <- schema type 'upload'
   */
  control: 'text' | 'select' | 'file';
  /** Required to submit — but see `conditional`: a hidden field is only
   *  enforced once revealed by a controlling answer. */
  required: boolean;
  /**
   * True when the field is `hidden` in the definition — a CONDITIONAL question
   * shown only after a controlling answer (e.g. datasite's "provide a copy of
   * the document", order 'c.a', appears when the non-compete question 'c' is
   * answered yes). Conditional fields are surfaced but never force a human up
   * front.
   */
  conditional: boolean;
  /** Sort key from the schema ('a','b','c','c.a',…) — dotted = sub-question. */
  order: string;
  /** True when a 'select'/choice control still needs its options fetched. */
  needsOptions: boolean;
  /**
   * Choice options {id, descriptor} for a 'select' control. Populated by
   * parseWorkdayQuestionnaire (the GET .../questionnaire/{id} response carries
   * `possibleAnswers`); absent on the shallow definition-schema parse.
   */
  options?: WorkdayQuestionOption[];
  /**
   * Set on a conditional (branch) field: which parent answer reveals it. The
   * orchestrator only answers this field when that parent option was chosen.
   */
  branchTrigger?: BranchTrigger;
}

export interface WorkdayQuestionOption {
  /** The option GUID submitted in questionMultipleChoiceAnswers. */
  id: string;
  /** Human label, e.g. 'Yes' / 'No'. */
  descriptor: string;
}

/**
 * For a conditional (branch) field: the parent question + the answer option
 * that reveals it. The field's answer is only submitted when the parent's
 * chosen answer matches this trigger.
 */
export interface BranchTrigger {
  questionId: string;
  answerId: string;
}

interface DefinitionSchema {
  definitions?: {
    primaryQuestionnaire?: {
      required?: string[];
      properties?: Record<
        string,
        {
          label?: string;
          type?: string;
          order?: string;
          hidden?: boolean;
          readOnly?: boolean;
        }
      >;
    };
  };
}

const CONTROL_BY_TYPE: Record<string, WorkdayQuestionnaireField['control']> = {
  string: 'text',
  integer: 'text',
  number: 'text',
  object: 'select',
  boolean: 'select',
  upload: 'file',
};

/** Compare Workday order keys ('a' < 'b' < 'c' < 'c.a' < 'd'), dotted-aware. */
function compareOrder(a: string, b: string): number {
  const pa = a.split('.');
  const pb = b.split('.');
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? '';
    const y = pb[i] ?? '';
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * A question as returned by `GET /wday/calypso/cxs/common/{tenant}/
 * questionnaire/{id}` — the endpoint that DOES carry options (unlike the
 * shallow `/definition` POST). Reverse-engineered from a live CACI response.
 */
interface LiveQuestion {
  id: string;
  body?: string;
  order?: string;
  required?: boolean;
  type?: { descriptor?: string }[];
  possibleAnswers?: LiveAnswer[];
}
interface LiveAnswer {
  id: string;
  answerText?: string;
  descriptor?: string;
  /** The conditional sub-question revealed when THIS answer is chosen. */
  branchingQuestion?: LiveQuestion;
}

/**
 * Parse the live `GET .../questionnaire/{id}` response into a FLAT list of
 * fields, WITH their option GUIDs and conditional branches:
 * - each question -> a field; `possibleAnswers` -> options {id, descriptor};
 * - a `type` mentioning "Text" -> a text control, else 'select' when it has
 *   options;
 * - a `branchingQuestion` under an answer -> a nested conditional field, flagged
 *   `conditional: true` with a `branchTrigger` (parent question + answer id),
 *   so the orchestrator only answers it when that option was chosen.
 *
 * This is the endpoint that unlocks Workday questionnaires over pure HTTP — no
 * browser scrape needed.
 */
export function parseWorkdayQuestionnaire(response: {
  questions?: unknown[];
}): WorkdayQuestionnaireField[] {
  const fields: WorkdayQuestionnaireField[] = [];
  const topLevel = (response.questions ?? []) as LiveQuestion[];

  const walk = (
    question: LiveQuestion,
    conditional: boolean,
    trigger: BranchTrigger | undefined,
  ): void => {
    const label = htmlEntityEncodedToPlainText(question.body ?? '').trim();
    const answers = question.possibleAnswers ?? [];
    const typeDescriptor = question.type?.[0]?.descriptor ?? '';
    const control: WorkdayQuestionnaireField['control'] = /text/i.test(
      typeDescriptor,
    )
      ? 'text'
      : answers.length > 0
        ? 'select'
        : 'text';

    if (label.length > 0 && question.id) {
      const options = answers
        .map((a) => ({
          id: a.id,
          descriptor: (a.answerText ?? a.descriptor ?? '').trim(),
        }))
        .filter((o) => o.id && o.descriptor.length > 0);
      const field: WorkdayQuestionnaireField = {
        id: question.id,
        label,
        control,
        // A conditional field is not enforced until its trigger is chosen.
        required: question.required === true && !conditional,
        conditional,
        order: question.order ?? '',
        needsOptions: false,
      };
      if (options.length > 0) {
        field.options = options;
      }
      if (trigger) {
        field.branchTrigger = trigger;
      }
      fields.push(field);
    }

    // Recurse into branch questions (conditional on the answer that reveals them).
    for (const answer of answers) {
      if (answer.branchingQuestion) {
        walk(answer.branchingQuestion, true, {
          questionId: question.id,
          answerId: answer.id,
        });
      }
    }
  };

  for (const question of topLevel) {
    walk(question, false, undefined);
  }
  return fields;
}

/**
 * Parse a questionnaire definition into ordered fields. read-only fields are
 * dropped (nothing to answer). Hidden (conditional) fields are kept but
 * reported as `required: false` (only enforced once revealed) with
 * `conditional: true`. Choice fields come back as 'select' with
 * `needsOptions: true` — their option values are fetched by the client.
 */
export function parseQuestionnaireDefinition(
  schema: DefinitionSchema,
): WorkdayQuestionnaireField[] {
  const primary = schema.definitions?.primaryQuestionnaire;
  const properties = primary?.properties ?? {};
  const requiredSet = new Set(primary?.required ?? []);

  const fields: WorkdayQuestionnaireField[] = [];
  for (const [id, prop] of Object.entries(properties)) {
    if (prop.readOnly === true) {
      continue;
    }
    const control = CONTROL_BY_TYPE[prop.type ?? ''] ?? 'text';
    const conditional = prop.hidden === true;
    fields.push({
      id,
      label: htmlEntityEncodedToPlainText(prop.label ?? '').trim(),
      control,
      // A conditional (hidden) field is not required until it is shown.
      required: requiredSet.has(id) && !conditional,
      conditional,
      order: prop.order ?? '',
      needsOptions: control === 'select',
    });
  }
  fields.sort((a, b) => compareOrder(a.order, b.order));
  return fields;
}

/**
 * Convert parsed Workday questionnaire fields into the platform-neutral
 * `Question[]` the task pipeline + answer resolver use, so Workday flows
 * through the SAME resolve → NEEDS_INPUT → dashboard → bank spine as every
 * other platform. Choice options become QuestionOptions matched on the human
 * descriptor (buildQuestionnaireResolution maps the chosen descriptor back to
 * the option GUID). Conditional/branch fields carry their required=false.
 */
export function workdayFieldsToQuestions(
  fields: WorkdayQuestionnaireField[],
): Question[] {
  const byId = new Map(fields.map((f) => [f.id, f]));
  return fields.map((field): Question => {
    const type: Question['type'] =
      field.control === 'select'
        ? 'select'
        : field.control === 'file'
          ? 'file'
          : 'text';
    const question: Question = {
      id: field.id,
      label: field.label,
      type,
      required: field.required,
    };
    if (field.options && field.options.length > 0) {
      question.options = field.options.map((o) => ({
        label: o.descriptor,
        value: o.descriptor,
      }));
    }
    if (field.conditional) {
      question.conditional = true;
      const help = branchHelpText(field.branchTrigger, byId);
      if (help) question.help = help;
    }
    return question;
  });
}

/** Longest a parent-question label may be inside a branch hint before it is
 *  truncated (branch parents can be full paragraphs of legal text). */
const BRANCH_PARENT_LABEL_MAX = 80;

/**
 * Build a human hint for a conditional field: "Shown only when '<parent>' is
 * answered '<option>'." Resolves the parent question's label and the triggering
 * option's descriptor from the flat field list. Returns undefined when the
 * trigger or its referents can't be resolved (the field is still flagged
 * conditional; it just carries no hint).
 */
function branchHelpText(
  trigger: BranchTrigger | undefined,
  byId: Map<string, WorkdayQuestionnaireField>,
): string | undefined {
  if (!trigger) return undefined;
  const parent = byId.get(trigger.questionId);
  if (!parent) return undefined;
  const option = parent.options?.find((o) => o.id === trigger.answerId);
  const parentLabel =
    parent.label.length > BRANCH_PARENT_LABEL_MAX
      ? `${parent.label.slice(0, BRANCH_PARENT_LABEL_MAX).trimEnd()}…`
      : parent.label;
  return option
    ? `Shown only when “${parentLabel}” is answered “${option.descriptor}”.`
    : `Shown only for a specific answer to “${parentLabel}”.`;
}
