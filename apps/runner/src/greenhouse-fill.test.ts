import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  normalizeLabel,
  planFill,
  stripLineBreaks,
} from './greenhouse-fill.js';
import type { FillQuestion } from './sower-client.js';

/**
 * Pure planner coverage (normalization, per-type actions, duplicate-label
 * occurrence indexes, skips) plus the guardrail: the filler source must
 * never contain a form-sending interaction — no submit-ish clicks and no
 * page-level keyboard at all — enforced by grepping the module itself.
 */

function question(overrides: Partial<FillQuestion>): FillQuestion {
  return {
    id: 'q1',
    label: 'Label',
    type: 'text',
    required: false,
    options: [],
    values: null,
    ...overrides,
  };
}

describe('normalizeLabel', () => {
  it('trims and collapses whitespace', () => {
    expect(normalizeLabel('  First   Name \n')).toBe('first name');
  });

  it('strips a trailing required marker', () => {
    expect(normalizeLabel('LinkedIn Profile *')).toBe('linkedin profile');
    expect(normalizeLabel('Resume/CV*')).toBe('resume/cv');
  });

  it('lowercases for tolerant matching', () => {
    expect(normalizeLabel('Email Address')).toBe('email address');
  });
});

describe('stripLineBreaks', () => {
  it('replaces CR/LF runs with single spaces for one-line inputs', () => {
    expect(stripLineBreaks('123 Main St\r\nSpringfield\nUSA')).toBe(
      '123 Main St Springfield USA',
    );
  });

  it('leaves break-free values untouched', () => {
    expect(stripLineBreaks('Ada Lovelace')).toBe('Ada Lovelace');
  });
});

describe('planFill', () => {
  it('text and textarea become fill actions with the raw value', () => {
    const actions = planFill([
      question({ id: 'a', label: 'Full Name*', values: ['Ada Lovelace'] }),
      question({
        id: 'b',
        label: 'Cover Letter',
        type: 'textarea',
        values: ['Dear team'],
      }),
    ]);
    expect(actions).toEqual([
      {
        kind: 'text',
        questionId: 'a',
        label: 'Full Name*',
        matchLabel: 'full name',
        matchIndex: 0,
        value: 'Ada Lovelace',
      },
      {
        kind: 'text',
        questionId: 'b',
        label: 'Cover Letter',
        matchLabel: 'cover letter',
        matchIndex: 0,
        value: 'Dear team',
      },
    ]);
  });

  it('joins multiple text values', () => {
    const actions = planFill([question({ values: ['One', 'Two'] })]);
    expect(actions[0]).toMatchObject({ kind: 'text', value: 'One, Two' });
  });

  it('select resolves the option label from the stored value', () => {
    const actions = planFill([
      question({
        type: 'select',
        label: 'Are you authorized to work? *',
        options: [
          { label: 'Yes', value: '1' },
          { label: 'No', value: '0' },
        ],
        values: ['1'],
      }),
    ]);
    expect(actions[0]).toEqual({
      kind: 'select',
      questionId: 'q1',
      label: 'Are you authorized to work? *',
      matchLabel: 'are you authorized to work?',
      matchIndex: 0,
      selection: { value: '1', optionLabel: 'Yes' },
    });
  });

  it('select keeps a null option label when the value has no match', () => {
    const actions = planFill([
      question({
        type: 'select',
        options: [{ label: 'Yes', value: '1' }],
        values: ['weird'],
      }),
    ]);
    expect(actions[0]).toMatchObject({
      selection: { value: 'weird', optionLabel: null },
    });
  });

  it('multiselect plans one selection per value', () => {
    const actions = planFill([
      question({
        type: 'multiselect',
        options: [
          { label: 'Remote', value: 'r' },
          { label: 'Onsite', value: 'o' },
        ],
        values: ['r', 'o'],
      }),
    ]);
    expect(actions[0]).toMatchObject({
      kind: 'multiselect',
      selections: [
        { value: 'r', optionLabel: 'Remote' },
        { value: 'o', optionLabel: 'Onsite' },
      ],
    });
  });

  it('file questions are skipped for manual attachment', () => {
    const actions = planFill([
      question({ type: 'file', label: 'Resume/CV*', values: null }),
    ]);
    expect(actions[0]).toEqual({
      kind: 'skip',
      questionId: 'q1',
      label: 'Resume/CV*',
      matchLabel: 'resume/cv',
      matchIndex: 0,
      detail: 'attach manually in the live view',
    });
  });

  it('unanswered questions are skipped', () => {
    const actions = planFill([
      question({ id: 'a', values: null }),
      question({ id: 'b', values: [] }),
    ]);
    expect(actions[0]).toMatchObject({
      kind: 'skip',
      detail: 'no saved answer',
    });
    expect(actions[1]).toMatchObject({
      kind: 'skip',
      detail: 'no saved answer',
    });
  });

  it('preserves question order', () => {
    const actions = planFill([
      question({ id: 'a', values: ['x'] }),
      question({ id: 'b', type: 'file' }),
      question({ id: 'c', values: null }),
    ]);
    expect(actions.map((action) => action.questionId)).toEqual(['a', 'b', 'c']);
  });

  it('assigns ascending occurrence indexes to duplicate labels', () => {
    // EEOC sections legitimately repeat labels with distinct question ids;
    // the executor binds the Nth occurrence to the Nth matching control
    // in DOM order, so one control never receives two questions' values.
    const actions = planFill([
      question({
        id: 'a',
        label: 'Status',
        type: 'select',
        options: [{ label: 'Yes', value: '1' }],
        values: ['1'],
      }),
      question({ id: 'b', label: 'Desired Salary', values: ['100'] }),
      question({
        id: 'c',
        label: 'Status *',
        type: 'select',
        options: [{ label: 'No', value: '0' }],
        values: ['0'],
      }),
    ]);
    expect(
      actions.map((action) => [action.matchLabel, action.matchIndex]),
    ).toEqual([
      ['status', 0],
      ['desired salary', 0],
      ['status', 1],
    ]);
  });

  it('counts skipped duplicates toward the occurrence index', () => {
    // The DOM renders a control for every payload question, answered or
    // not — a skipped first twin still pushes its later twin to index 1.
    const actions = planFill([
      question({ id: 'a', label: 'Veteran Status', values: null }),
      question({ id: 'b', label: 'veteran status *', values: ['x'] }),
    ]);
    expect(actions[0]).toMatchObject({ kind: 'skip', matchIndex: 0 });
    expect(actions[1]).toMatchObject({
      kind: 'text',
      matchLabel: 'veteran status',
      matchIndex: 1,
    });
  });
});

describe('executor safety', () => {
  const source = readFileSync(
    new URL('./greenhouse-fill.ts', import.meta.url),
    'utf8',
  );

  it('the filler source contains no form-sending interaction', () => {
    expect(source).not.toMatch(/submit/i);
  });

  it('never uses the page-level keyboard or an Enter press', () => {
    expect(source).not.toMatch(/keyboard\.press/);
    expect(source).not.toMatch(/keyboard\.type/);
    expect(source).not.toMatch(/press\('Enter'/);
    expect(source).not.toMatch(/press\("Enter"/);
  });

  it('never clicks anything named like a send button', () => {
    for (const line of source.split('\n')) {
      if (/click/i.test(line)) {
        expect(line).not.toMatch(/submit|apply/i);
      }
    }
  });
});
