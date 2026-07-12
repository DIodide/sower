import type { TaskEvent, TaskState } from './types.js';

/**
 * Thrown when an event is not allowed from the current state.
 */
export class InvalidTransitionError extends Error {
  readonly state: TaskState;
  readonly event: TaskEvent;

  constructor(state: TaskState, event: TaskEvent) {
    super(
      `Invalid transition: event "${event}" is not allowed from state "${state}"`,
    );
    this.name = 'InvalidTransitionError';
    this.state = state;
    this.event = event;
  }
}

/**
 * Table-driven task state machine. Every TaskState has an entry; states with
 * an empty map are terminal (or currently have no outbound transitions).
 */
export const ALLOWED: Record<
  TaskState,
  Partial<Record<TaskEvent, TaskState>>
> = {
  INGESTED: {
    PARSE_OK: 'PARSED',
    PARSE_DUPLICATE: 'DUPLICATE',
  },
  PARSED: {
    ENQUEUE: 'QUEUED',
    // Parsed fine but nothing can process it yet (unknown platform, missing
    // tenant, or no adapter registered): park for manual input.
    PARK: 'NEEDS_INPUT',
  },
  QUEUED: {
    PROCESS_START: 'PREPARING',
    FAIL: 'FAILED',
  },
  PREPARING: {
    RESOLVED_ALL: 'REVIEW',
    RESOLVED_PARTIAL: 'NEEDS_INPUT',
    FAIL: 'FAILED',
  },
  NEEDS_INPUT: {
    RETRY: 'QUEUED',
    FAIL: 'FAILED',
  },
  REVIEW: {
    APPROVED: 'FILLING',
    SUBMIT_OK: 'SUBMITTED',
    FAIL: 'FAILED',
  },
  // OTP flows arrive with account-based platforms in M3/M4; the edges exist
  // now so AWAITING_OTP is reachable and the table never needs a hot patch.
  AWAITING_OTP: {
    RETRY: 'FILLING',
  },
  FILLING: {
    FILLED: 'REVIEW',
    NEED_OTP: 'AWAITING_OTP',
    FAIL: 'FAILED',
  },
  SUBMITTED: {
    CONFIRM: 'CONFIRMED',
    FAIL: 'FAILED',
  },
  CONFIRMED: {},
  FAILED: {
    RETRY: 'QUEUED',
    // Cloud Tasks re-delivers after a 500: a FAILED task may be claimed
    // directly for another processing attempt (subject to the attempt cap).
    PROCESS_START: 'PREPARING',
  },
  DUPLICATE: {},
};

/**
 * Returns the next state for `event` from `state`, or throws
 * InvalidTransitionError when the transition is not allowed.
 */
export function transition(state: TaskState, event: TaskEvent): TaskState {
  const next = ALLOWED[state][event];
  if (next === undefined) {
    throw new InvalidTransitionError(state, event);
  }
  return next;
}

/**
 * Returns true when `event` is allowed from `state`.
 */
export function canTransition(state: TaskState, event: TaskEvent): boolean {
  return ALLOWED[state][event] !== undefined;
}
