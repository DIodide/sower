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
