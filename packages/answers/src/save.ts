import type { Question } from '@sower/core';
import { answers, type Database, documents } from '@sower/db';
import { z } from 'zod';
import {
  type BankValue,
  documentKind,
  normalizeCompanyKey,
  normalizeLabel,
} from './resolve.js';

/**
 * THE write path into the user answers bank — shared by the dashboard's
 * "Save answers" form and the api's POST /tasks/:id/answers, so both surfaces
 * store answers with ONE set of semantics:
 *
 * - keys: (company, normalizeLabel(question.label)) — the answers table's
 *   unique index; an upsert per key, so a re-save replaces, never duplicates
 * - scope: text/textarea answers are COMPANY-SCOPED by default (they only
 *   auto-fill future applications at the same company); scope 'global'
 *   saves them for every company. Select/multiselect/file answers are
 *   always global. No company → everything is global.
 * - select/multiselect values must EXACTLY match one of the question's
 *   option values and are stored as {value,label} pairs (resolvable by
 *   value on this form, by label on any other tenant's variant)
 * - file answers are DOCUMENT IDS: the document must exist and be of the
 *   question's kind (documentKind); the stored value is its storagePath
 * - text answers are trimmed and capped at ANSWER_MAX_CHARS
 * - only the task's own questions are writable: an unknown questionId is an
 *   error, never a write
 *
 * TRUTHFULNESS: only explicit user input lands here (source 'user'); nothing
 * is derived or guessed.
 */

/** The 20k cap every user text shares (task notes, job notes, answers). */
export const ANSWER_MAX_CHARS = 20_000;

export type AnswerScope = 'company' | 'global';

export interface AnswerInput {
  questionId: string;
  /**
   * text/textarea/select: one string; multiselect: string[] (a lone string
   * is accepted as a one-item pick); file: a documents row id.
   */
  value: string | string[];
  /** text/textarea only; ignored for other types. Default 'company'. */
  scope?: AnswerScope;
}

export interface AnswerSaveError {
  questionId: string;
  /** The question's label; null when the id names no question. */
  label: string | null;
  message: string;
}

/** One planned upsert — what a valid AnswerInput becomes. */
export interface AnswerWrite {
  questionId: string;
  question: Question;
  value: BankValue;
  /** The normalized company key ('' = global). */
  company: string;
}

export interface SaveAnswersResult {
  /** Question ids whose answer was written, in input order. */
  saved: string[];
  errors: AnswerSaveError[];
}

/** The documents-table columns the file-answer check reads. */
export interface DocumentRow {
  id: string;
  kind: string;
  storagePath: string;
}

const uuidSchema = z.string().uuid();
const textAnswerSchema = z.string().trim().min(1).max(ANSWER_MAX_CHARS);

/** option value id -> human label, for validating and labeling select saves. */
function optionLabelByValue(question: Question): Map<string, string> {
  return new Map(
    (question.options ?? []).map((o) => [String(o.value), o.label]),
  );
}

type Planned = { write: AnswerWrite } | { error: string };

function planFile(
  question: Question,
  value: string | string[],
  documentRows: DocumentRow[],
): Planned {
  if (Array.isArray(value)) {
    return { error: 'a file answer is one document id' };
  }
  if (!uuidSchema.safeParse(value).success) {
    return { error: 'invalid document reference' };
  }
  const doc = documentRows.find((row) => row.id === value);
  if (!doc) {
    return { error: 'selected document no longer exists' };
  }
  const kind = documentKind(question);
  if (doc.kind !== kind) {
    return {
      error: `selected document is kind "${doc.kind}", expected "${kind}"`,
    };
  }
  // Document picks are global: the same resume/cover letter is reusable
  // across companies. The stored value is the storagePath (what the
  // resolver binds to).
  return {
    write: {
      questionId: question.id,
      question,
      value: doc.storagePath,
      company: '',
    },
  };
}

function planMultiselect(
  question: Question,
  value: string | string[],
): Planned {
  const raw = (Array.isArray(value) ? value : [value]).filter(
    (item) => item !== '',
  );
  if (raw.length === 0) {
    return { error: 'value is required' };
  }
  const labels = optionLabelByValue(question);
  if (raw.some((item) => !labels.has(item))) {
    return { error: "value not among the question's options" };
  }
  // Store {value,label} pairs: the label is what the answers page shows
  // and what lets the pick resolve on another company's form, where
  // option value ids differ (see matchStoredOption).
  return {
    write: {
      questionId: question.id,
      question,
      value: raw.map((item) => ({
        value: item,
        label: labels.get(item) ?? item,
      })),
      company: '',
    },
  };
}

function planSelect(question: Question, value: string | string[]): Planned {
  if (Array.isArray(value)) {
    return { error: 'a select answer is one value' };
  }
  const label = optionLabelByValue(question).get(value);
  if (label === undefined) {
    return { error: "value not among the question's options" };
  }
  // {value,label}: human-readable in the library, resolvable by value on
  // this form and by label on any other tenant's variant of it.
  return {
    write: {
      questionId: question.id,
      question,
      value: { value, label },
      company: '',
    },
  };
}

function planText(
  question: Question,
  value: string | string[],
  scope: AnswerScope,
  companyKey: string,
): Planned {
  if (Array.isArray(value)) {
    return { error: 'a text answer is one value' };
  }
  const parsed = textAnswerSchema.safeParse(value);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'invalid value' };
  }
  return {
    write: {
      questionId: question.id,
      question,
      value: parsed.data,
      company: scope === 'global' ? '' : companyKey,
    },
  };
}

/**
 * Validate answers against the task's questions and turn them into planned
 * upserts — PURE (the documents rows are passed in). Every input yields
 * exactly one write or one error; nothing is skipped silently.
 */
export function planAnswerWrites(
  questions: Question[],
  inputs: AnswerInput[],
  context: {
    /** The task's company (raw display name; normalized here). */
    company: string | null | undefined;
    /** The documents table (only consulted for file questions). */
    documents: DocumentRow[];
  },
): { writes: AnswerWrite[]; errors: AnswerSaveError[] } {
  const companyKey = normalizeCompanyKey(context.company ?? undefined);
  const byId = new Map(questions.map((question) => [question.id, question]));
  const writes: AnswerWrite[] = [];
  const errors: AnswerSaveError[] = [];
  for (const input of inputs) {
    const question = byId.get(input.questionId);
    if (!question) {
      errors.push({
        questionId: input.questionId,
        label: null,
        message: 'not a question of this task',
      });
      continue;
    }
    // A label that normalizes to '' (e.g. all punctuation) can't be a bank
    // key — it would collide with every other empty-label answer in scope.
    if (normalizeLabel(question.label) === '') {
      errors.push({
        questionId: question.id,
        label: question.label,
        message: 'question label cannot key a saved answer',
      });
      continue;
    }
    let planned: Planned;
    switch (question.type) {
      case 'file':
        planned = planFile(question, input.value, context.documents);
        break;
      case 'multiselect':
        planned = planMultiselect(question, input.value);
        break;
      case 'select':
        planned = planSelect(question, input.value);
        break;
      default:
        planned = planText(
          question,
          input.value,
          input.scope ?? 'company',
          companyKey,
        );
        break;
    }
    if ('error' in planned) {
      errors.push({
        questionId: question.id,
        label: question.label,
        message: planned.error,
      });
    } else {
      writes.push(planned.write);
    }
  }
  return { writes, errors };
}

/**
 * Upsert one bank answer keyed by (company, normalized label). `company` is
 * a normalized company key ('' = GLOBAL): a company-scoped save never
 * touches the global row and vice versa, so one company's essay answer can
 * never overwrite — or leak to — another company's. Atomic on the unique
 * index: a concurrent double-save can't create two rows.
 */
export async function upsertBankAnswer(
  db: Database,
  write: AnswerWrite,
): Promise<void> {
  const normalized = normalizeLabel(write.question.label);
  await db
    .insert(answers)
    .values({
      questionLabel: write.question.label,
      normalizedLabel: normalized,
      value: write.value,
      source: 'user',
      company: write.company,
    })
    .onConflictDoUpdate({
      target: [answers.company, answers.normalizedLabel],
      set: {
        questionLabel: write.question.label,
        value: write.value,
        source: 'user',
      },
    });
}

/**
 * Validate + write answers for a task's questions. Default: every valid
 * answer is written and the invalid ones are reported (the dashboard form's
 * tolerant save). `allOrNothing`: a single invalid answer means NO write at
 * all (the api route's 400 must not leave half the batch behind). A write
 * that throws mid-batch is reported as that question's error; the others
 * still land.
 */
export async function saveAnswersToBank(
  db: Database,
  input: {
    questions: Question[];
    company: string | null | undefined;
    answers: AnswerInput[];
  },
  options: { allOrNothing?: boolean } = {},
): Promise<SaveAnswersResult> {
  const questionById = new Map(input.questions.map((q) => [q.id, q]));
  // The whole (small, personal) documents table — read only when a file
  // question is being answered; the plan needs id + kind + storagePath.
  const needsDocuments = input.answers.some(
    (answer) => questionById.get(answer.questionId)?.type === 'file',
  );
  const documentRows: DocumentRow[] = needsDocuments
    ? (
        await db
          .select({
            id: documents.id,
            kind: documents.kind,
            storagePath: documents.storagePath,
          })
          .from(documents)
      ).map((row) => ({
        id: row.id,
        kind: row.kind,
        storagePath: row.storagePath,
      }))
    : [];
  const plan = planAnswerWrites(input.questions, input.answers, {
    company: input.company,
    documents: documentRows,
  });
  if (options.allOrNothing === true && plan.errors.length > 0) {
    return { saved: [], errors: plan.errors };
  }
  const saved: string[] = [];
  const errors = [...plan.errors];
  for (const write of plan.writes) {
    try {
      await upsertBankAnswer(db, write);
      saved.push(write.questionId);
    } catch (err) {
      errors.push({
        questionId: write.questionId,
        label: write.question.label,
        message: err instanceof Error ? err.message : 'failed to save',
      });
    }
  }
  return { saved, errors };
}
