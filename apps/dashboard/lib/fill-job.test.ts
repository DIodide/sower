import { describe, expect, it } from 'vitest';
import { FILL_OUTCOME_TONE, fillStatusMeta, parseFillReport } from './fill-job';

describe('fillStatusMeta', () => {
  it('maps every fill_jobs status to its chip', () => {
    expect(fillStatusMeta('requested')).toEqual({
      label: 'waiting for the runner…',
      tone: 'progress',
      active: true,
    });
    expect(fillStatusMeta('claimed')).toEqual({
      label: 'filling…',
      tone: 'progress',
      active: true,
    });
    expect(fillStatusMeta('running')).toEqual({
      label: 'filling…',
      tone: 'progress',
      active: true,
    });
    expect(fillStatusMeta('ready')).toEqual({
      label: 'browser ready',
      tone: 'success',
      active: false,
    });
    expect(fillStatusMeta('failed')).toEqual({
      label: 'failed',
      tone: 'danger',
      active: false,
    });
  });

  it('degrades an unknown status to a neutral inactive chip, never the raw enum', () => {
    expect(fillStatusMeta('SOME_NEW_STATE')).toEqual({
      label: 'some new state',
      tone: 'neutral',
      active: false,
    });
  });
});

describe('FILL_OUTCOME_TONE', () => {
  it('uses success/neutral/danger for filled/skipped/failed', () => {
    expect(FILL_OUTCOME_TONE.filled).toBe('success');
    expect(FILL_OUTCOME_TONE.skipped).toBe('neutral');
    expect(FILL_OUTCOME_TONE.failed).toBe('danger');
  });
});

describe('parseFillReport', () => {
  it('returns [] for non-array report values', () => {
    expect(parseFillReport(null)).toEqual([]);
    expect(parseFillReport(undefined)).toEqual([]);
    expect(parseFillReport({})).toEqual([]);
    expect(parseFillReport('filled')).toEqual([]);
  });

  it('keeps well-formed entries in order', () => {
    const report = [
      { questionId: 'q1', label: 'First name', outcome: 'filled' },
      {
        questionId: 'q2',
        label: 'Resume',
        outcome: 'skipped',
        detail: 'attach manually in the live view',
      },
      {
        questionId: 'q3',
        label: 'Pronouns',
        outcome: 'failed',
        detail: 'no matching option',
      },
    ];
    expect(parseFillReport(report)).toEqual(report);
  });

  it('drops malformed entries without losing the valid ones', () => {
    const report = [
      null,
      'nope',
      ['questionId'],
      { questionId: 'q1', label: 'First name', outcome: 'filled' },
      { questionId: 'q2', outcome: 'filled' },
      { label: 'No id', outcome: 'filled' },
      { questionId: 'q3', label: 'Bad outcome', outcome: 'submitted' },
    ];
    expect(parseFillReport(report)).toEqual([
      { questionId: 'q1', label: 'First name', outcome: 'filled' },
    ]);
  });

  it('omits blank or non-string details', () => {
    expect(
      parseFillReport([
        { questionId: 'q1', label: 'A', outcome: 'filled', detail: '' },
        { questionId: 'q2', label: 'B', outcome: 'failed', detail: 42 },
      ]),
    ).toEqual([
      { questionId: 'q1', label: 'A', outcome: 'filled' },
      { questionId: 'q2', label: 'B', outcome: 'failed' },
    ]);
  });
});
