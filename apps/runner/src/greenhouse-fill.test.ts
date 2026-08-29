import { readFileSync } from 'node:fs';
import type { Page } from 'playwright-core';
import { describe, expect, it } from 'vitest';
import type { FillAction } from './greenhouse-fill.js';
import {
  isRetryableFailure,
  looseLabelKey,
  markAbsentFormOnly,
  normalizeLabel,
  pickOptionIndex,
  planFill,
  stripLineBreaks,
  summarizeFailure,
  waitForFormReady,
} from './greenhouse-fill.js';
import type { FillQuestion, FillReportItem } from './sower-client.js';

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
        formOnly: false,
        value: 'Ada Lovelace',
      },
      {
        kind: 'text',
        questionId: 'b',
        label: 'Cover Letter',
        matchLabel: 'cover letter',
        matchIndex: 0,
        formOnly: false,
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
      formOnly: false,
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
      formOnly: false,
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

describe('looseLabelKey', () => {
  it('ties a run-together payload label to the spaced form label', () => {
    // The live EEOC block ships 'Disability Status' / 'Veteran Status'
    // while the payload carries them run together; both must land.
    expect(looseLabelKey('DisabilityStatus')).toBe(
      looseLabelKey('Disability Status*'),
    );
    expect(looseLabelKey('VeteranStatus')).toBe(
      looseLabelKey('Veteran Status'),
    );
  });

  it('keeps genuinely different labels apart', () => {
    expect(looseLabelKey('First Name')).not.toBe(looseLabelKey('Last Name'));
  });
});

describe('isRetryableFailure', () => {
  it('recognises a re-render that killed the action', () => {
    expect(
      isRetryableFailure(
        new Error('locator.evaluateAll: Execution context was destroyed'),
      ),
    ).toBe(true);
    expect(
      isRetryableFailure(new Error('Element is not attached to the DOM')),
    ).toBe(true);
  });

  it('recognises an action that could not land in time', () => {
    // A few-pixel-wide combobox input, clicked while something was still
    // animating over it.
    expect(
      isRetryableFailure(new Error('locator.click: Timeout 10000ms exceeded.')),
    ).toBe(true);
  });

  it('leaves a real miss alone', () => {
    expect(
      isRetryableFailure(new Error('no form control labeled "race"')),
    ).toBe(false);
    expect(
      isRetryableFailure(new Error("option list did not show 'Princeton'")),
    ).toBe(false);
  });
});

describe('waitForFormReady', () => {
  function stubPage(counts: number[]) {
    const calls = { counts: 0, waits: 0, attached: 0 };
    const page = {
      waitForLoadState: async () => undefined,
      locator: () => ({
        first: () => ({
          waitFor: async () => {
            calls.attached += 1;
          },
        }),
        count: async () => {
          const value = counts[Math.min(calls.counts, counts.length - 1)] ?? 0;
          calls.counts += 1;
          return value;
        },
      }),
      waitForTimeout: async () => {
        calls.waits += 1;
      },
    };
    return { page: page as unknown as Page, calls };
  }

  it('waits for the control count to stop growing', async () => {
    // The board streams questions in: 3, then 7, then all 12.
    const { page, calls } = stubPage([3, 7, 12, 12]);
    await waitForFormReady(page, 30_000);
    expect(calls.attached).toBe(1);
    expect(calls.counts).toBe(4);
    expect(calls.waits).toBe(3);
  });

  it('returns as soon as a stable form is already rendered', async () => {
    const { page, calls } = stubPage([12, 12]);
    await waitForFormReady(page, 30_000);
    expect(calls.waits).toBe(1);
  });

  it('propagates the timeout when no control ever appears', async () => {
    const page = {
      waitForLoadState: async () => undefined,
      locator: () => ({
        first: () => ({
          waitFor: async () => {
            throw new Error('Timeout 1000ms exceeded.');
          },
        }),
        count: async () => 0,
      }),
      waitForTimeout: async () => undefined,
    } as unknown as Page;
    await expect(waitForFormReady(page, 1_000)).rejects.toThrow(/Timeout/);
  });
});

describe('pickOptionIndex', () => {
  it('takes an exact match over any partial', () => {
    expect(
      pickOptionIndex(['bachelor of arts', 'bachelors'], 'bachelors'),
    ).toBe(1);
  });

  it('accepts a lone containment match on the narrowed list', () => {
    // The typed text already filtered the widget's list.
    expect(pickOptionIndex(["bachelor's degree"], 'bachelors degree')).toBe(-1);
    expect(pickOptionIndex(['princeton university'], 'princeton')).toBe(0);
  });

  it('refuses to guess between two candidates', () => {
    expect(
      pickOptionIndex(
        ['computer science', 'computer science and engineering'],
        'computer',
      ),
    ).toBe(-1);
  });

  it('ignores empty option text', () => {
    expect(pickOptionIndex(['', 'princeton university'], 'princeton')).toBe(1);
  });
});

describe('markAbsentFormOnly', () => {
  const action = (id: string, formOnly: boolean): FillAction => ({
    kind: 'text',
    questionId: id,
    label: id,
    matchLabel: id,
    matchIndex: 0,
    formOnly,
    value: 'v',
  });

  it('turns a missing form-only control into a skip', () => {
    // Boards differ over which education sub-fields they render, so an
    // absent one is a fact about the posting, not a failure.
    const report: FillReportItem[] = [
      {
        questionId: 'start-month--0',
        label: 'Start date month',
        outcome: 'failed',
        detail: 'no form control labeled "start date month"',
      },
    ];
    markAbsentFormOnly([action('start-month--0', true)], report);
    expect(report[0]).toEqual({
      questionId: 'start-month--0',
      label: 'Start date month',
      outcome: 'skipped',
      detail: 'not on this form',
    });
  });

  it('leaves an API-described question failing', () => {
    const report: FillReportItem[] = [
      {
        questionId: 'first_name',
        label: 'First Name',
        outcome: 'failed',
        detail: 'no form control labeled "first name"',
      },
    ];
    markAbsentFormOnly([action('first_name', false)], report);
    expect(report[0]?.outcome).toBe('failed');
  });

  it('leaves a form-only question that failed for another reason', () => {
    const report: FillReportItem[] = [
      {
        questionId: 'school--0',
        label: 'School',
        outcome: 'failed',
        detail: "option list did not show 'Princeton University'",
      },
    ];
    markAbsentFormOnly([action('school--0', true)], report);
    expect(report[0]?.outcome).toBe('failed');
  });
});

describe('planFill form-only passthrough', () => {
  it('carries the synthesized marker onto the action', () => {
    const actions = planFill([
      question({ id: 'country', label: 'Country', values: ['United States'] }),
      question({ id: 'email', label: 'Email', values: ['a@b.c'] }),
    ]);
    expect(actions.map((a) => a.formOnly)).toEqual([false, false]);
    const marked = planFill([
      {
        ...question({
          id: 'country',
          label: 'Country',
          values: ['United States'],
        }),
        formOnly: true,
      },
    ]);
    expect(marked[0]?.formOnly).toBe(true);
  });
});

describe('summarizeFailure', () => {
  it('leaves a short message alone', () => {
    expect(summarizeFailure(new Error('no form control labeled "race"'))).toBe(
      'no form control labeled "race"',
    );
  });

  it('keeps the reason at the end of a long call log', () => {
    // Playwright's diagnosis is its last line; trimming from the front
    // alone would throw away the only part that says why.
    const message = `locator.click: Timeout 10000ms exceeded.\nCall log:\n${'  - waiting\n'.repeat(80)}  - <div class="iti__dropdown"> intercepts pointer events`;
    const summary = summarizeFailure(new Error(message));
    expect(summary.length).toBeLessThanOrEqual(600);
    expect(summary).toContain('locator.click: Timeout');
    expect(summary).toContain('intercepts pointer events');
  });
});
