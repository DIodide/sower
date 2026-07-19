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
  // DISCARD (a human removing the task from the queue) is allowed from every
  // non-terminal state EXCEPT SUBMITTED/CONFIRMED: an application that was
  // already sent cannot be "removed from the queue" anymore.
  //
  // MARK_SUBMITTED (a human completed the application out of band, outside
  // sower) shares exactly that set of source states: any task still in
  // flight can be declared applied, jumping straight to SUBMITTED. It is
  // meaningless from SUBMITTED/CONFIRMED (already sent) and from the
  // DISCARDED/DUPLICATE archive (restore first).
  INGESTED: {
    PARSE_OK: 'PARSED',
    PARSE_DUPLICATE: 'DUPLICATE',
    DISCARD: 'DISCARDED',
    MARK_SUBMITTED: 'SUBMITTED',
  },
  PARSED: {
    ENQUEUE: 'QUEUED',
    // Parsed fine but nothing can process it yet (unknown platform, missing
    // tenant, or no adapter registered): park for manual input.
    PARK: 'NEEDS_INPUT',
    DISCARD: 'DISCARDED',
    MARK_SUBMITTED: 'SUBMITTED',
  },
  QUEUED: {
    PROCESS_START: 'PREPARING',
    FAIL: 'FAILED',
    DISCARD: 'DISCARDED',
    MARK_SUBMITTED: 'SUBMITTED',
  },
  PREPARING: {
    RESOLVED_ALL: 'REVIEW',
    RESOLVED_PARTIAL: 'NEEDS_INPUT',
    FAIL: 'FAILED',
    DISCARD: 'DISCARDED',
    MARK_SUBMITTED: 'SUBMITTED',
  },
  NEEDS_INPUT: {
    RETRY: 'QUEUED',
    FAIL: 'FAILED',
    DISCARD: 'DISCARDED',
    MARK_SUBMITTED: 'SUBMITTED',
  },
  REVIEW: {
    APPROVED: 'FILLING',
    SUBMIT_OK: 'SUBMITTED',
    FAIL: 'FAILED',
    DISCARD: 'DISCARDED',
    MARK_SUBMITTED: 'SUBMITTED',
  },
  // OTP flows arrive with account-based platforms in M3/M4; the edges exist
  // now so AWAITING_OTP is reachable and the table never needs a hot patch.
  AWAITING_OTP: {
    RETRY: 'FILLING',
    DISCARD: 'DISCARDED',
    MARK_SUBMITTED: 'SUBMITTED',
  },
  FILLING: {
    FILLED: 'REVIEW',
    NEED_OTP: 'AWAITING_OTP',
    FAIL: 'FAILED',
    DISCARD: 'DISCARDED',
    MARK_SUBMITTED: 'SUBMITTED',
  },
  SUBMITTED: {
    CONFIRM: 'CONFIRMED',
    FAIL: 'FAILED',
    // Undo of an out-of-band MARK_SUBMITTED (a mis-click on "Mark applied").
    // The table allows it from any SUBMITTED task; the api endpoint adds the
    // history guard — only a task whose latest SUBMITTED-entering event is
    // MARK_SUBMITTED may be un-marked (a real SUBMIT_OK can't be taken back).
    // Like RESTORE, it lands in NEEDS_INPUT: a human decides what's next.
    UNMARK_SUBMITTED: 'NEEDS_INPUT',
  },
  CONFIRMED: {},
  FAILED: {
    RETRY: 'QUEUED',
    // Cloud Tasks re-delivers after a 500: a FAILED task may be claimed
    // directly for another processing attempt (subject to the attempt cap).
    PROCESS_START: 'PREPARING',
    DISCARD: 'DISCARDED',
    MARK_SUBMITTED: 'SUBMITTED',
  },
  DUPLICATE: {},
  // A discarded task can be brought back (the Archive section's Restore /
  // an undo after a mis-click). It lands in NEEDS_INPUT — a human decides
  // what happens next — rather than trying to reconstruct its prior state.
  DISCARDED: {
    RESTORE: 'NEEDS_INPUT',
  },
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
