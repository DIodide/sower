import type { Question, ResolvedAnswer } from '@sower/core';
import { describe, expect, it } from 'vitest';
import { buildFillPlan } from './fill-plan.js';

const textQ: Question = {
  id: 'firstName',
  label: 'First name',
  type: 'text',
  required: true,
};
const essayQ: Question = {
  id: 'whyUs',
  label: 'Why do you want to work here?',
  type: 'textarea',
  required: false,
};
const selectQ: Question = {
  id: 'authorized',
  label: 'Are you authorized to work?',
  type: 'select',
  required: true,
  options: [
    { label: 'Yes', value: 'true' },
    { label: 'No', value: 'false' },
  ],
};
const multiQ: Question = {
  id: 'langs',
  label: 'Languages',
  type: 'multiselect',
  required: false,
  options: [
    { label: 'EN', value: 'en' },
    { label: 'FR', value: 'fr' },
    { label: 'ES', value: 'es' },
  ],
};
const fileQ: Question = {
  id: 'resume',
  label: 'Resume',
  type: 'file',
  required: true,
};

function ans(
  questionId: string,
  value: ResolvedAnswer['value'],
  source: ResolvedAnswer['source'] = 'profile',
): ResolvedAnswer {
  return { questionId, value, source };
}

describe('buildFillPlan — never invent', () => {
  it('emits an action ONLY for questions with a resolved answer', () => {
    const plan = buildFillPlan([textQ, essayQ], [ans('firstName', 'Ada')]);
    expect(plan.actions).toEqual([
      {
        kind: 'text',
        questionId: 'firstName',
        label: 'First name',
        value: 'Ada',
      },
    ]);
    expect(plan.skipped.map((q) => q.id)).toEqual(['whyUs']);
  });

  it('carries the resolved value verbatim (no transformation)', () => {
    const plan = buildFillPlan([essayQ], [ans('whyUs', 'Because A & B <ok>')]);
    expect(plan.actions[0]).toMatchObject({ value: 'Because A & B <ok>' });
  });

  it('counts skipped required questions', () => {
    const plan = buildFillPlan([textQ, essayQ], []);
    expect(plan.actions).toEqual([]);
    expect(plan.skipped).toHaveLength(2);
    expect(plan.skippedRequired).toBe(1); // only firstName is required
  });

  it('skips a null-valued answer', () => {
    const plan = buildFillPlan([textQ], [ans('firstName', null)]);
    expect(plan.actions).toEqual([]);
    expect(plan.skippedRequired).toBe(1);
  });

  it('skips a text field given an array answer (no guessed join)', () => {
    const plan = buildFillPlan([textQ], [ans('firstName', ['a', 'b'])]);
    expect(plan.actions).toEqual([]);
  });
});

describe('buildFillPlan — select guards', () => {
  it('fills a select only with a value the control offers', () => {
    const ok = buildFillPlan([selectQ], [ans('authorized', 'true')]);
    expect(ok.actions[0]).toEqual({
      kind: 'select',
      questionId: 'authorized',
      label: 'Are you authorized to work?',
      optionValue: 'true',
    });

    const bad = buildFillPlan([selectQ], [ans('authorized', 'maybe')]);
    expect(bad.actions).toEqual([]);
    expect(bad.skippedRequired).toBe(1);
  });

  it('multiselect keeps only option-matching values, drops the rest', () => {
    const plan = buildFillPlan([multiQ], [ans('langs', ['en', 'zz', 'fr'])]);
    expect(plan.actions[0]).toEqual({
      kind: 'multiselect',
      questionId: 'langs',
      label: 'Languages',
      optionValues: ['en', 'fr'],
    });
  });

  it('multiselect with no matching value is skipped', () => {
    const plan = buildFillPlan([multiQ], [ans('langs', ['zz'])]);
    expect(plan.actions).toEqual([]);
  });

  it('accepts a single-string multiselect answer that matches', () => {
    const plan = buildFillPlan([multiQ], [ans('langs', 'es')]);
    expect(plan.actions[0]).toMatchObject({ optionValues: ['es'] });
  });
});

describe('buildFillPlan — file', () => {
  it('fills a file only from a document-sourced storage path', () => {
    const plan = buildFillPlan(
      [fileQ],
      [ans('resume', 'documents/doc-1/resume.pdf', 'document')],
    );
    expect(plan.actions[0]).toEqual({
      kind: 'file',
      questionId: 'resume',
      label: 'Resume',
      storagePath: 'documents/doc-1/resume.pdf',
    });
  });

  it('skips a file answer that is not document-sourced', () => {
    const plan = buildFillPlan(
      [fileQ],
      [ans('resume', 'documents/doc-1/resume.pdf', 'profile')],
    );
    expect(plan.actions).toEqual([]);
  });
});
