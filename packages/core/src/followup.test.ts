import { describe, expect, it } from 'vitest';
import {
  canFollowupTransition,
  FOLLOWUP_ALLOWED,
  FOLLOWUP_EVENT_LABELS,
  FOLLOWUP_KIND_LABELS,
  FOLLOWUP_STATE_LABELS,
  type FollowupEvent,
  type FollowupKind,
  type FollowupState,
  followupTransition,
  InvalidFollowupTransitionError,
  OPEN_FOLLOWUP_STATES,
} from './followup.js';

const ALL_STATES: FollowupState[] = [
  'RECEIVED',
  'ACTION_NEEDED',
  'SCHEDULED',
  'WAITING',
  'DONE',
  'DISMISSED',
];

const ALL_EVENTS: FollowupEvent[] = [
  'TRIAGE',
  'SCHEDULE',
  'COMPLETE_STEP',
  'RESOLVE',
  'DISMISS',
  'REOPEN',
];

const ALL_KINDS: FollowupKind[] = [
  'assessment',
  'interview',
  'recruiter',
  'offer',
  'rejection',
  'other',
];

/** RESOLVE/DISMISS close out any of these (every non-terminal state). */
const NON_TERMINAL_STATES: FollowupState[] = [
  'RECEIVED',
  'ACTION_NEEDED',
  'SCHEDULED',
  'WAITING',
];

const VALID_TRANSITIONS: Array<[FollowupState, FollowupEvent, FollowupState]> =
  [
    ['RECEIVED', 'TRIAGE', 'ACTION_NEEDED'],
    ['RECEIVED', 'SCHEDULE', 'SCHEDULED'],
    ['ACTION_NEEDED', 'SCHEDULE', 'SCHEDULED'],
    ['WAITING', 'SCHEDULE', 'SCHEDULED'],
    ['RECEIVED', 'COMPLETE_STEP', 'WAITING'],
    ['ACTION_NEEDED', 'COMPLETE_STEP', 'WAITING'],
    ['SCHEDULED', 'COMPLETE_STEP', 'WAITING'],
    ...NON_TERMINAL_STATES.map(
      (state): [FollowupState, FollowupEvent, FollowupState] => [
        state,
        'RESOLVE',
        'DONE',
      ],
    ),
    ...NON_TERMINAL_STATES.map(
      (state): [FollowupState, FollowupEvent, FollowupState] => [
        state,
        'DISMISS',
        'DISMISSED',
      ],
    ),
    ['DONE', 'REOPEN', 'ACTION_NEEDED'],
    ['DISMISSED', 'REOPEN', 'ACTION_NEEDED'],
  ];

function isValid(state: FollowupState, event: FollowupEvent): boolean {
  return VALID_TRANSITIONS.some(([s, e]) => s === state && e === event);
}

describe('followupTransition', () => {
  it.each(VALID_TRANSITIONS)('%s + %s -> %s', (from, event, to) => {
    expect(followupTransition(from, event)).toBe(to);
  });

  it('throws InvalidFollowupTransitionError on every disallowed (state, event) pair', () => {
    for (const state of ALL_STATES) {
      for (const event of ALL_EVENTS) {
        if (isValid(state, event)) continue;
        expect(() => followupTransition(state, event)).toThrow(
          InvalidFollowupTransitionError,
        );
      }
    }
  });

  it('error message includes both the state and the event', () => {
    try {
      followupTransition('DONE', 'SCHEDULE');
      expect.unreachable('followupTransition should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidFollowupTransitionError);
      const e = err as InvalidFollowupTransitionError;
      expect(e.message).toContain('DONE');
      expect(e.message).toContain('SCHEDULE');
      expect(e.state).toBe('DONE');
      expect(e.event).toBe('SCHEDULE');
      expect(e.name).toBe('InvalidFollowupTransitionError');
    }
  });

  it('InvalidFollowupTransitionError is an Error subclass', () => {
    const err = new InvalidFollowupTransitionError('WAITING', 'TRIAGE');
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain('WAITING');
    expect(err.message).toContain('TRIAGE');
  });

  it('supports the assessment happy path: triage, complete the OA, resolve', () => {
    let state: FollowupState = 'RECEIVED';
    for (const event of ['TRIAGE', 'COMPLETE_STEP', 'RESOLVE'] as const) {
      state = followupTransition(state, event);
    }
    expect(state).toBe('DONE');
  });

  it('supports the interview loop: schedule, complete, re-schedule the next round', () => {
    expect(followupTransition('RECEIVED', 'SCHEDULE')).toBe('SCHEDULED');
    expect(followupTransition('SCHEDULED', 'COMPLETE_STEP')).toBe('WAITING');
    expect(followupTransition('WAITING', 'SCHEDULE')).toBe('SCHEDULED');
  });

  it('supports RESOLVE and DISMISS from every non-terminal state', () => {
    for (const state of NON_TERMINAL_STATES) {
      expect(followupTransition(state, 'RESOLVE')).toBe('DONE');
      expect(followupTransition(state, 'DISMISS')).toBe('DISMISSED');
    }
  });

  it('TRIAGE is valid from RECEIVED only', () => {
    for (const state of ALL_STATES) {
      expect(canFollowupTransition(state, 'TRIAGE')).toBe(state === 'RECEIVED');
    }
  });

  it('COMPLETE_STEP is valid from RECEIVED/ACTION_NEEDED/SCHEDULED only', () => {
    for (const state of ALL_STATES) {
      expect(canFollowupTransition(state, 'COMPLETE_STEP')).toBe(
        state === 'RECEIVED' ||
          state === 'ACTION_NEEDED' ||
          state === 'SCHEDULED',
      );
    }
  });

  it('SCHEDULE is valid from RECEIVED/ACTION_NEEDED/WAITING only', () => {
    for (const state of ALL_STATES) {
      expect(canFollowupTransition(state, 'SCHEDULE')).toBe(
        state === 'RECEIVED' ||
          state === 'ACTION_NEEDED' ||
          state === 'WAITING',
      );
    }
  });

  it('DONE/DISMISSED are terminal except REOPEN, which lands in ACTION_NEEDED', () => {
    for (const state of ['DONE', 'DISMISSED'] as FollowupState[]) {
      for (const event of ALL_EVENTS) {
        expect(canFollowupTransition(state, event)).toBe(event === 'REOPEN');
      }
      expect(followupTransition(state, 'REOPEN')).toBe('ACTION_NEEDED');
    }
  });

  it('REOPEN is valid from DONE/DISMISSED only', () => {
    for (const state of ALL_STATES) {
      expect(canFollowupTransition(state, 'REOPEN')).toBe(
        state === 'DONE' || state === 'DISMISSED',
      );
    }
  });

  it('a reopened follow-up can be closed out again', () => {
    expect(
      followupTransition(followupTransition('DONE', 'REOPEN'), 'RESOLVE'),
    ).toBe('DONE');
    expect(
      followupTransition(followupTransition('DISMISSED', 'REOPEN'), 'DISMISS'),
    ).toBe('DISMISSED');
  });
});

describe('canFollowupTransition', () => {
  it('agrees with the transition table for every (state, event) pair', () => {
    for (const state of ALL_STATES) {
      for (const event of ALL_EVENTS) {
        expect(canFollowupTransition(state, event)).toBe(isValid(state, event));
      }
    }
  });
});

describe('FOLLOWUP_ALLOWED table', () => {
  it('has an entry for every state', () => {
    for (const state of ALL_STATES) {
      expect(FOLLOWUP_ALLOWED[state]).toBeDefined();
    }
  });

  it('contains exactly the specified transitions and nothing more', () => {
    const total = ALL_STATES.reduce(
      (n, s) => n + Object.keys(FOLLOWUP_ALLOWED[s]).length,
      0,
    );
    expect(total).toBe(VALID_TRANSITIONS.length);
  });

  it('every state except RECEIVED is reachable from some transition', () => {
    const reachable = new Set(VALID_TRANSITIONS.map(([, , to]) => to));
    for (const state of ALL_STATES) {
      if (state === 'RECEIVED') continue;
      expect(reachable.has(state), `state ${state} should be reachable`).toBe(
        true,
      );
    }
  });
});

describe('OPEN_FOLLOWUP_STATES', () => {
  it('is exactly the non-terminal states, in lifecycle order', () => {
    expect(OPEN_FOLLOWUP_STATES).toEqual([
      'RECEIVED',
      'ACTION_NEEDED',
      'SCHEDULED',
      'WAITING',
    ]);
  });

  it('agrees with the table: open states have outbound non-REOPEN edges, terminal states do not', () => {
    for (const state of ALL_STATES) {
      const open = (OPEN_FOLLOWUP_STATES as FollowupState[]).includes(state);
      expect(
        Object.keys(FOLLOWUP_ALLOWED[state]).some((e) => e !== 'REOPEN'),
      ).toBe(open);
    }
  });
});

describe('labels', () => {
  it('covers every state with a human label', () => {
    for (const state of ALL_STATES) {
      expect(FOLLOWUP_STATE_LABELS[state]).toBeTruthy();
    }
    expect(FOLLOWUP_STATE_LABELS.ACTION_NEEDED).toBe('Action needed');
    expect(FOLLOWUP_STATE_LABELS.RECEIVED).toBe('Received');
  });

  it('covers every event with a human label', () => {
    for (const event of ALL_EVENTS) {
      expect(FOLLOWUP_EVENT_LABELS[event]).toBeTruthy();
    }
    expect(FOLLOWUP_EVENT_LABELS.COMPLETE_STEP).toBe('Complete step');
  });

  it('covers every kind with a human label', () => {
    for (const kind of ALL_KINDS) {
      expect(FOLLOWUP_KIND_LABELS[kind]).toBeTruthy();
    }
    expect(FOLLOWUP_KIND_LABELS.assessment).toBe('Assessment');
    expect(FOLLOWUP_KIND_LABELS.rejection).toBe('Rejection');
  });
});
