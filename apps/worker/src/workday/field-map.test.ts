import { describe, expect, it } from 'vitest';
import {
  type RawField,
  rawFieldsToQuestions,
  rawFieldToQuestion,
} from './field-map.js';

function field(overrides: Partial<RawField>): RawField {
  return {
    automationId: 'q-1',
    label: 'A question',
    control: 'text',
    required: false,
    ...overrides,
  };
}

describe('rawFieldToQuestion', () => {
  it('maps text and textarea', () => {
    expect(rawFieldToQuestion(field({ control: 'text' }))?.type).toBe('text');
    expect(rawFieldToQuestion(field({ control: 'textarea' }))?.type).toBe(
      'textarea',
    );
  });

  it('maps a date control to text', () => {
    expect(rawFieldToQuestion(field({ control: 'date' }))?.type).toBe('text');
  });

  it('maps select/radio to a guarded select with options', () => {
    const q = rawFieldToQuestion(
      field({
        control: 'select',
        options: [
          { label: 'Yes', value: '1' },
          { label: 'No', value: '2' },
        ],
      }),
    );
    expect(q?.type).toBe('select');
    expect(q?.options).toEqual([
      { label: 'Yes', value: '1' },
      { label: 'No', value: '2' },
    ]);
  });

  it('maps a lone checkbox to a Yes/No select', () => {
    const q = rawFieldToQuestion(field({ control: 'checkbox' }));
    expect(q?.type).toBe('select');
    expect(q?.options).toEqual([
      { label: 'Yes', value: 'true' },
      { label: 'No', value: 'false' },
    ]);
  });

  it('maps a file control to file', () => {
    expect(rawFieldToQuestion(field({ control: 'file' }))?.type).toBe('file');
  });

  it('carries the automation-id as the question id and preserves required', () => {
    const q = rawFieldToQuestion(
      field({ automationId: 'legalName--firstName', required: true }),
    );
    expect(q?.id).toBe('legalName--firstName');
    expect(q?.required).toBe(true);
  });

  it('drops fields with an empty label or id (unanswerable)', () => {
    expect(rawFieldToQuestion(field({ label: '   ' }))).toBeNull();
    expect(rawFieldToQuestion(field({ automationId: '' }))).toBeNull();
  });

  it('drops a select/multiselect with no readable options', () => {
    expect(
      rawFieldToQuestion(field({ control: 'select', options: [] })),
    ).toBeNull();
    expect(rawFieldToQuestion(field({ control: 'multiselect' }))).toBeNull();
  });

  it('an unknown control with options stays a guarded select', () => {
    const q = rawFieldToQuestion(
      field({ control: 'unknown', options: [{ label: 'X', value: 'x' }] }),
    );
    expect(q?.type).toBe('select');
  });

  it('an unknown control without options degrades to free text', () => {
    expect(rawFieldToQuestion(field({ control: 'unknown' }))?.type).toBe(
      'text',
    );
  });

  it('trims option labels and drops empty ones', () => {
    const q = rawFieldToQuestion(
      field({
        control: 'select',
        options: [
          { label: '  Yes  ', value: '1' },
          { label: '', value: '2' },
        ],
      }),
    );
    expect(q?.options).toEqual([{ label: 'Yes', value: '1' }]);
  });
});

describe('rawFieldsToQuestions', () => {
  it('maps many, drops unanswerable, de-dupes by automation-id', () => {
    const questions = rawFieldsToQuestions([
      field({ automationId: 'a', control: 'text', label: 'First name' }),
      field({ automationId: 'a', control: 'text', label: 'First name (dup)' }),
      field({ automationId: 'b', control: 'select', options: [] }),
      field({ automationId: 'c', control: 'textarea', label: 'Why us?' }),
    ]);
    expect(questions.map((q) => q.id)).toEqual(['a', 'c']);
  });
});
