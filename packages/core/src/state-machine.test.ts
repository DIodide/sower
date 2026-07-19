import { describe, expect, it } from 'vitest';
import {
  ALLOWED,
  canTransition,
  InvalidTransitionError,
  transition,
} from './state-machine.js';
import type { TaskEvent, TaskState } from './types.js';

const ALL_STATES: TaskState[] = [
  'INGESTED',
  'PARSED',
  'QUEUED',
  'PREPARING',
  'NEEDS_INPUT',
  'REVIEW',
  'AWAITING_OTP',
  'FILLING',
  'SUBMITTED',
  'CONFIRMED',
  'FAILED',
  'DUPLICATE',
  'DISCARDED',
];

const ALL_EVENTS: TaskEvent[] = [
  'PARSE_OK',
  'PARSE_DUPLICATE',
  'ENQUEUE',
  'PARK',
  'PROCESS_START',
  'RESOLVED_ALL',
  'RESOLVED_PARTIAL',
  'APPROVED',
  'FILLED',
  'NEED_OTP',
  'SUBMIT_OK',
  'CONFIRM',
  'FAIL',
  'RETRY',
  'DISCARD',
  'RESTORE',
  'MARK_SUBMITTED',
  'UNMARK_SUBMITTED',
];

/** Every state a task may be DISCARDed from (all non-terminal states except
 * SUBMITTED — a sent application can't be removed from the queue).
 * MARK_SUBMITTED (applied out of band) is allowed from exactly this set. */
const DISCARDABLE_STATES: TaskState[] = [
  'INGESTED',
  'PARSED',
  'QUEUED',
  'PREPARING',
  'NEEDS_INPUT',
  'REVIEW',
  'AWAITING_OTP',
  'FILLING',
  'FAILED',
];

const VALID_TRANSITIONS: Array<[TaskState, TaskEvent, TaskState]> = [
  ['INGESTED', 'PARSE_OK', 'PARSED'],
  ['INGESTED', 'PARSE_DUPLICATE', 'DUPLICATE'],
  ['PARSED', 'ENQUEUE', 'QUEUED'],
  ['PARSED', 'PARK', 'NEEDS_INPUT'],
  ['QUEUED', 'PROCESS_START', 'PREPARING'],
  ['PREPARING', 'RESOLVED_ALL', 'REVIEW'],
  ['PREPARING', 'RESOLVED_PARTIAL', 'NEEDS_INPUT'],
  ['PREPARING', 'FAIL', 'FAILED'],
  ['QUEUED', 'FAIL', 'FAILED'],
  ['FAILED', 'RETRY', 'QUEUED'],
  ['FAILED', 'PROCESS_START', 'PREPARING'],
  ['REVIEW', 'APPROVED', 'FILLING'],
  ['REVIEW', 'FAIL', 'FAILED'],
  ['FILLING', 'FILLED', 'REVIEW'],
  ['FILLING', 'NEED_OTP', 'AWAITING_OTP'],
  ['FILLING', 'FAIL', 'FAILED'],
  ['AWAITING_OTP', 'RETRY', 'FILLING'],
  ['REVIEW', 'SUBMIT_OK', 'SUBMITTED'],
  ['SUBMITTED', 'CONFIRM', 'CONFIRMED'],
  ['SUBMITTED', 'FAIL', 'FAILED'],
  ['NEEDS_INPUT', 'RETRY', 'QUEUED'],
  ['NEEDS_INPUT', 'FAIL', 'FAILED'],
  ...DISCARDABLE_STATES.map((state): [TaskState, TaskEvent, TaskState] => [
    state,
    'DISCARD',
    'DISCARDED',
  ]),
  ...DISCARDABLE_STATES.map((state): [TaskState, TaskEvent, TaskState] => [
    state,
    'MARK_SUBMITTED',
    'SUBMITTED',
  ]),
  ['DISCARDED', 'RESTORE', 'NEEDS_INPUT'],
  ['SUBMITTED', 'UNMARK_SUBMITTED', 'NEEDS_INPUT'],
];

function isValid(state: TaskState, event: TaskEvent): boolean {
  return VALID_TRANSITIONS.some(([s, e]) => s === state && e === event);
}

describe('transition', () => {
  it.each(VALID_TRANSITIONS)('%s + %s -> %s', (from, event, to) => {
    expect(transition(from, event)).toBe(to);
  });

  it('throws InvalidTransitionError on every disallowed (state, event) pair', () => {
    for (const state of ALL_STATES) {
      for (const event of ALL_EVENTS) {
        if (isValid(state, event)) continue;
        expect(() => transition(state, event)).toThrow(InvalidTransitionError);
      }
    }
  });

  it('error message includes both the state and the event', () => {
    try {
      transition('CONFIRMED', 'RETRY');
      expect.unreachable('transition should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidTransitionError);
      const e = err as InvalidTransitionError;
      expect(e.message).toContain('CONFIRMED');
      expect(e.message).toContain('RETRY');
      expect(e.state).toBe('CONFIRMED');
      expect(e.event).toBe('RETRY');
      expect(e.name).toBe('InvalidTransitionError');
    }
  });

  it('InvalidTransitionError is an Error subclass', () => {
    const err = new InvalidTransitionError('DUPLICATE', 'ENQUEUE');
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain('DUPLICATE');
    expect(err.message).toContain('ENQUEUE');
  });

  it('supports the happy path from INGESTED through CONFIRMED', () => {
    let state: TaskState = 'INGESTED';
    for (const event of [
      'PARSE_OK',
      'ENQUEUE',
      'PROCESS_START',
      'RESOLVED_ALL',
      'APPROVED',
      'FILLED',
      'SUBMIT_OK',
      'CONFIRM',
    ] as TaskEvent[]) {
      state = transition(state, event);
    }
    expect(state).toBe('CONFIRMED');
  });

  it('supports the retry loop FAILED -> QUEUED and NEEDS_INPUT -> QUEUED', () => {
    expect(transition(transition('QUEUED', 'FAIL'), 'RETRY')).toBe('QUEUED');
    expect(
      transition(transition('PREPARING', 'RESOLVED_PARTIAL'), 'RETRY'),
    ).toBe('QUEUED');
  });

  it('supports parking a parsed task that nothing can process yet', () => {
    expect(transition('PARSED', 'PARK')).toBe('NEEDS_INPUT');
  });

  it('supports re-claiming a FAILED task directly (Cloud Tasks re-delivery)', () => {
    expect(transition('FAILED', 'PROCESS_START')).toBe('PREPARING');
  });

  it('supports the OTP loop FILLING -> AWAITING_OTP -> FILLING', () => {
    expect(transition('FILLING', 'NEED_OTP')).toBe('AWAITING_OTP');
    expect(transition('AWAITING_OTP', 'RETRY')).toBe('FILLING');
  });

  it('supports DISCARD from every non-terminal state except SUBMITTED', () => {
    for (const state of DISCARDABLE_STATES) {
      expect(transition(state, 'DISCARD')).toBe('DISCARDED');
    }
  });

  it('refuses DISCARD once an application was sent (SUBMITTED/CONFIRMED)', () => {
    for (const state of ['SUBMITTED', 'CONFIRMED'] as TaskState[]) {
      expect(() => transition(state, 'DISCARD')).toThrow(
        InvalidTransitionError,
      );
      expect(canTransition(state, 'DISCARD')).toBe(false);
    }
  });

  it('supports MARK_SUBMITTED (applied out of band) from every discardable state', () => {
    for (const state of DISCARDABLE_STATES) {
      expect(transition(state, 'MARK_SUBMITTED')).toBe('SUBMITTED');
    }
  });

  it('refuses MARK_SUBMITTED once sent (SUBMITTED/CONFIRMED) or archived (DISCARDED/DUPLICATE)', () => {
    for (const state of [
      'SUBMITTED',
      'CONFIRMED',
      'DISCARDED',
      'DUPLICATE',
    ] as TaskState[]) {
      expect(() => transition(state, 'MARK_SUBMITTED')).toThrow(
        InvalidTransitionError,
      );
      expect(canTransition(state, 'MARK_SUBMITTED')).toBe(false);
    }
  });

  it('a task marked applied out of band can still be confirmed (SUBMITTED -> CONFIRMED)', () => {
    expect(
      transition(transition('NEEDS_INPUT', 'MARK_SUBMITTED'), 'CONFIRM'),
    ).toBe('CONFIRMED');
  });

  it('DISCARDED allows only RESTORE (back to NEEDS_INPUT)', () => {
    for (const event of ALL_EVENTS) {
      expect(canTransition('DISCARDED', event)).toBe(event === 'RESTORE');
    }
    expect(transition('DISCARDED', 'RESTORE')).toBe('NEEDS_INPUT');
  });

  it('RESTORE is valid from DISCARDED only', () => {
    for (const state of ALL_STATES) {
      expect(canTransition(state, 'RESTORE')).toBe(state === 'DISCARDED');
    }
  });

  it('supports UNMARK_SUBMITTED (un-mark applied) from SUBMITTED back to NEEDS_INPUT', () => {
    expect(transition('SUBMITTED', 'UNMARK_SUBMITTED')).toBe('NEEDS_INPUT');
    // Round trip: a mis-clicked "Mark applied" is fully reversible.
    expect(
      transition(
        transition('NEEDS_INPUT', 'MARK_SUBMITTED'),
        'UNMARK_SUBMITTED',
      ),
    ).toBe('NEEDS_INPUT');
  });

  it('UNMARK_SUBMITTED is valid from SUBMITTED only (CONFIRMED stays terminal)', () => {
    for (const state of ALL_STATES) {
      expect(canTransition(state, 'UNMARK_SUBMITTED')).toBe(
        state === 'SUBMITTED',
      );
    }
    expect(() => transition('CONFIRMED', 'UNMARK_SUBMITTED')).toThrow(
      InvalidTransitionError,
    );
  });
});

describe('canTransition', () => {
  it('agrees with the transition table for every (state, event) pair', () => {
    for (const state of ALL_STATES) {
      for (const event of ALL_EVENTS) {
        expect(canTransition(state, event)).toBe(isValid(state, event));
      }
    }
  });
});

describe('ALLOWED table', () => {
  it('has an entry for every state', () => {
    for (const state of ALL_STATES) {
      expect(ALLOWED[state]).toBeDefined();
    }
  });

  it('terminal states DUPLICATE and CONFIRMED have no outbound transitions', () => {
    expect(Object.keys(ALLOWED.DUPLICATE)).toHaveLength(0);
    expect(Object.keys(ALLOWED.CONFIRMED)).toHaveLength(0);
    // DISCARDED is escapable — but only via RESTORE.
    expect(Object.keys(ALLOWED.DISCARDED)).toEqual(['RESTORE']);
  });

  it('every state except INGESTED is reachable from some transition', () => {
    const reachable = new Set(VALID_TRANSITIONS.map(([, , to]) => to));
    for (const state of ALL_STATES) {
      if (state === 'INGESTED') continue;
      expect(reachable.has(state), `state ${state} should be reachable`).toBe(
        true,
      );
    }
  });

  it('contains exactly the specified transitions and nothing more', () => {
    const total = ALL_STATES.reduce(
      (n, s) => n + Object.keys(ALLOWED[s]).length,
      0,
    );
    expect(total).toBe(VALID_TRANSITIONS.length);
  });
});
