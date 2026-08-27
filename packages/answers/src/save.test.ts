import type { Question } from '@sower/core';
import type { Database } from '@sower/db';
import { answers, documents } from '@sower/db';
import { describe, expect, it } from 'vitest';
import {
  type AnswerInput,
  planAnswerWrites,
  saveAnswersToBank,
} from './save.js';

/**
 * The shared bank writer: planAnswerWrites (pure validation → upserts:
 * unknown ids, option matching, {value,label} shapes, company vs global
 * scope, document-kind checks, the 20k cap) and saveAnswersToBank against
 * a fake db (upsert shape, input order, all-or-nothing, a throwing write
 * reported without sinking the batch, documents read only when needed).
 */

const DOC_ID = 'eeeeeeee-0000-4000-8000-000000000001';
const OTHER_DOC_ID = 'eeeeeeee-0000-4000-8000-000000000002';

const questions: Question[] = [
  { id: 'q-name', label: 'Full name', type: 'text', required: true },
  { id: 'q-why', label: 'Why here?', type: 'textarea', required: false },
  {
    id: 'q-visa',
    label: 'Need sponsorship?',
    type: 'select',
    required: true,
    options: [
      { label: 'Yes', value: 1 },
      { label: 'No', value: 0 },
    ],
  },
  {
    id: 'q-langs',
    label: 'Languages',
    type: 'multiselect',
    required: false,
    options: [
      { label: 'TypeScript', value: 'ts' },
      { label: 'Rust', value: 'rs' },
    ],
  },
  { id: 'q-resume', label: 'Resume / CV', type: 'file', required: true },
  { id: 'q-punct', label: '???', type: 'text', required: false },
];

const docs = [
  { id: DOC_ID, kind: 'resume', storagePath: 'documents/x/resume.pdf' },
  { id: OTHER_DOC_ID, kind: 'cover_letter', storagePath: 'documents/y/cl.pdf' },
];

function plan(inputs: AnswerInput[], company: string | null = 'Acme Corp') {
  return planAnswerWrites(questions, inputs, { company, documents: docs });
}

describe('planAnswerWrites', () => {
  it('rejects an id that is not one of the task questions', () => {
    const { writes, errors } = plan([{ questionId: 'nope', value: 'x' }]);
    expect(writes).toEqual([]);
    expect(errors).toEqual([
      {
        questionId: 'nope',
        label: null,
        message: 'not a question of this task',
      },
    ]);
  });

  it('text answers are company-scoped by default, global on request, trimmed', () => {
    const { writes, errors } = plan([
      { questionId: 'q-name', value: '  Jane Doe ' },
      { questionId: 'q-why', value: 'Because.', scope: 'global' },
    ]);
    expect(errors).toEqual([]);
    expect(writes.map((w) => [w.questionId, w.value, w.company])).toEqual([
      ['q-name', 'Jane Doe', 'acme corp'],
      ['q-why', 'Because.', ''],
    ]);
  });

  it('a task without a company saves text globally', () => {
    const { writes } = plan([{ questionId: 'q-name', value: 'Jane' }], null);
    expect(writes[0]?.company).toBe('');
  });

  it('text answers reject arrays, blanks, and over-cap values', () => {
    const { errors } = plan([
      { questionId: 'q-name', value: ['a', 'b'] },
      { questionId: 'q-why', value: '   ' },
      { questionId: 'q-name', value: 'x'.repeat(20_001) },
    ]);
    expect(errors.map((e) => e.questionId)).toEqual([
      'q-name',
      'q-why',
      'q-name',
    ]);
    expect(errors[0]?.message).toBe('a text answer is one value');
    expect(errors[1]?.message).toMatch(/at least 1/);
    expect(errors[2]?.message).toMatch(/at most 20000/);
  });

  it('select answers must match an option value and store {value,label} globally', () => {
    const ok = plan([{ questionId: 'q-visa', value: '0' }]);
    expect(ok.writes[0]).toMatchObject({
      questionId: 'q-visa',
      value: { value: '0', label: 'No' },
      company: '',
    });
    const bad = plan([
      { questionId: 'q-visa', value: 'No' },
      { questionId: 'q-visa', value: ['0'] },
    ]);
    expect(bad.errors.map((e) => e.message)).toEqual([
      "value not among the question's options",
      'a select answer is one value',
    ]);
  });

  it('multiselect answers take an array (or one string), every item an option', () => {
    const ok = plan([
      { questionId: 'q-langs', value: ['ts', 'rs'] },
      { questionId: 'q-langs', value: 'rs' },
    ]);
    expect(ok.errors).toEqual([]);
    expect(ok.writes[0]?.value).toEqual([
      { value: 'ts', label: 'TypeScript' },
      { value: 'rs', label: 'Rust' },
    ]);
    expect(ok.writes[1]?.value).toEqual([{ value: 'rs', label: 'Rust' }]);
    const bad = plan([
      { questionId: 'q-langs', value: ['ts', 'go'] },
      { questionId: 'q-langs', value: [] },
    ]);
    expect(bad.errors.map((e) => e.message)).toEqual([
      "value not among the question's options",
      'value is required',
    ]);
  });

  it('file answers are document ids of the right kind, stored as the storagePath', () => {
    const ok = plan([{ questionId: 'q-resume', value: DOC_ID }]);
    expect(ok.writes[0]).toMatchObject({
      value: 'documents/x/resume.pdf',
      company: '',
    });
    const bad = plan([
      { questionId: 'q-resume', value: 'not-a-uuid' },
      { questionId: 'q-resume', value: 'eeeeeeee-0000-4000-8000-000000000009' },
      { questionId: 'q-resume', value: OTHER_DOC_ID },
      { questionId: 'q-resume', value: [DOC_ID] },
    ]);
    expect(bad.errors.map((e) => e.message)).toEqual([
      'invalid document reference',
      'selected document no longer exists',
      'selected document is kind "cover_letter", expected "resume"',
      'a file answer is one document id',
    ]);
  });

  it('refuses a label that normalizes to nothing (it could key no answer)', () => {
    const { errors } = plan([{ questionId: 'q-punct', value: 'x' }]);
    expect(errors[0]?.message).toBe('question label cannot key a saved answer');
  });
});

interface Upsert {
  values: unknown;
  conflict: unknown;
}

function createFakeDb(options: {
  documents?: unknown[];
  upserts?: Upsert[];
  failOn?: string;
  selects?: number[];
}): Database {
  const chain = (values: unknown) => ({
    values: (arg: unknown) => {
      if (
        options.failOn !== undefined &&
        (arg as { normalizedLabel: string }).normalizedLabel === options.failOn
      ) {
        throw new Error('db exploded');
      }
      return {
        onConflictDoUpdate: (conflict: unknown) => {
          options.upserts?.push({ values: arg, conflict });
          return Promise.resolve(values);
        },
      };
    },
  });
  return {
    select: () => {
      options.selects?.push(1);
      return {
        from: (table: unknown) => {
          expect(table).toBe(documents);
          return Promise.resolve(options.documents ?? []);
        },
      };
    },
    insert: (table: unknown) => {
      expect(table).toBe(answers);
      return chain([]);
    },
  } as unknown as Database;
}

describe('saveAnswersToBank', () => {
  it('upserts each valid answer keyed by (company, normalized label) in input order', async () => {
    const upserts: Upsert[] = [];
    const selects: number[] = [];
    const db = createFakeDb({ upserts, selects });
    const result = await saveAnswersToBank(db, {
      questions,
      company: 'Acme Corp',
      answers: [
        { questionId: 'q-visa', value: '1' },
        { questionId: 'q-name', value: 'Jane' },
        { questionId: 'ghost', value: 'x' },
      ],
    });
    expect(result.saved).toEqual(['q-visa', 'q-name']);
    expect(result.errors).toEqual([
      {
        questionId: 'ghost',
        label: null,
        message: 'not a question of this task',
      },
    ]);
    expect(upserts.map((u) => u.values)).toEqual([
      {
        questionLabel: 'Need sponsorship?',
        normalizedLabel: 'need sponsorship',
        value: { value: '1', label: 'Yes' },
        source: 'user',
        company: '',
      },
      {
        questionLabel: 'Full name',
        normalizedLabel: 'full name',
        value: 'Jane',
        source: 'user',
        company: 'acme corp',
      },
    ]);
    expect(upserts[0]?.conflict).toMatchObject({
      target: [answers.company, answers.normalizedLabel],
      set: { value: { value: '1', label: 'Yes' }, source: 'user' },
    });
    // No file question in the batch → the documents table is never read.
    expect(selects).toEqual([]);
  });

  it('reads the documents table only for file answers and binds the pick', async () => {
    const upserts: Upsert[] = [];
    const selects: number[] = [];
    const db = createFakeDb({ upserts, selects, documents: docs });
    const result = await saveAnswersToBank(db, {
      questions,
      company: null,
      answers: [{ questionId: 'q-resume', value: DOC_ID }],
    });
    expect(selects).toHaveLength(1);
    expect(result.saved).toEqual(['q-resume']);
    expect(upserts[0]?.values).toMatchObject({
      normalizedLabel: 'resume cv',
      value: 'documents/x/resume.pdf',
      company: '',
    });
  });

  it('allOrNothing: one invalid answer means nothing is written', async () => {
    const upserts: Upsert[] = [];
    const db = createFakeDb({ upserts });
    const result = await saveAnswersToBank(
      db,
      {
        questions,
        company: 'Acme',
        answers: [
          { questionId: 'q-name', value: 'Jane' },
          { questionId: 'q-visa', value: 'maybe' },
        ],
      },
      { allOrNothing: true },
    );
    expect(result.saved).toEqual([]);
    expect(result.errors.map((e) => e.questionId)).toEqual(['q-visa']);
    expect(upserts).toEqual([]);
  });

  it('a write that throws is reported on its question; the rest still land', async () => {
    const upserts: Upsert[] = [];
    const db = createFakeDb({ upserts, failOn: 'full name' });
    const result = await saveAnswersToBank(db, {
      questions,
      company: 'Acme',
      answers: [
        { questionId: 'q-name', value: 'Jane' },
        { questionId: 'q-why', value: 'Because.' },
      ],
    });
    expect(result.saved).toEqual(['q-why']);
    expect(result.errors).toEqual([
      { questionId: 'q-name', label: 'Full name', message: 'db exploded' },
    ]);
    expect(upserts).toHaveLength(1);
  });
});
