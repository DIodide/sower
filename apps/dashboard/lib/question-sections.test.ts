import { describe, expect, it } from 'vitest';
import {
  isJobSpecificProse,
  type SectionQuestion,
  staysAnswerable,
} from './question-sections.js';

function question(overrides: Partial<SectionQuestion>): SectionQuestion {
  return { status: 'resolved', type: 'text', ...overrides };
}

describe('isJobSpecificProse', () => {
  it('counts a free-text box as prose', () => {
    expect(isJobSpecificProse(question({ type: 'textarea' }))).toBe(true);
  });

  it('counts a length-capped question as prose whatever its type', () => {
    // A form only caps an answer it expects someone to write.
    expect(
      isJobSpecificProse(
        question({ type: 'text', limit: { kind: 'words', max: 200 } }),
      ),
    ).toBe(true);
  });

  it('leaves the repeat facts alone', () => {
    for (const type of ['text', 'select', 'multiselect', 'file'] as const) {
      expect(isJobSpecificProse(question({ type }))).toBe(false);
    }
  });
});

describe('staysAnswerable', () => {
  it('keeps a resolved essay editable', () => {
    // The GitHub-projects essay resolved from the answer bank: answered,
    // but written for this job and worth revising per application.
    expect(staysAnswerable(question({ type: 'textarea' }))).toBe(true);
  });

  it('collapses a resolved repeat fact', () => {
    expect(staysAnswerable(question({ type: 'text' }))).toBe(false);
    expect(staysAnswerable(question({ type: 'select' }))).toBe(false);
  });

  it('says nothing about questions that are not resolved yet', () => {
    expect(
      staysAnswerable(question({ status: 'missing', type: 'textarea' })),
    ).toBe(false);
    expect(
      staysAnswerable(question({ status: 'saved', type: 'textarea' })),
    ).toBe(false);
  });
});
