/**
 * Post-application follow-ups: things that arrive AFTER an application was
 * sent (OA invites, interview requests, recruiter mail, offers, rejections).
 * Each follow-up is its own small record with its own state machine below —
 * the parent task's state machine is never involved.
 */

/** What kind of thing arrived. */
export type FollowupKind =
  | 'assessment'
  | 'interview'
  | 'recruiter'
  | 'offer'
  | 'rejection'
  | 'other';

export type FollowupState =
  | 'RECEIVED'
  | 'ACTION_NEEDED'
  | 'SCHEDULED'
  | 'WAITING'
  | 'DONE'
  | 'DISMISSED';

export type FollowupEvent =
  | 'TRIAGE'
  | 'SCHEDULE'
  | 'COMPLETE_STEP'
  | 'RESOLVE'
  | 'DISMISS'
  | 'REOPEN';

/**
 * Thrown when an event is not allowed from the current follow-up state
 * (mirrors the task machine's InvalidTransitionError).
 */
export class InvalidFollowupTransitionError extends Error {
  readonly state: FollowupState;
  readonly event: FollowupEvent;

  constructor(state: FollowupState, event: FollowupEvent) {
    super(
      `Invalid follow-up transition: event "${event}" is not allowed from state "${state}"`,
    );
    this.name = 'InvalidFollowupTransitionError';
    this.state = state;
    this.event = event;
  }
}

/**
 * Table-driven follow-up state machine (the task ALLOWED table's shape).
 * Every FollowupState has an entry; DONE/DISMISSED are terminal except for
 * REOPEN, which lands in ACTION_NEEDED — a human decides what's next, never
 * a reconstruction of the prior state.
 */
export const FOLLOWUP_ALLOWED: Record<
  FollowupState,
  Partial<Record<FollowupEvent, FollowupState>>
> = {
  // RESOLVE (fully handled) and DISMISS (waved off) are allowed from every
  // non-terminal state: any open follow-up can be closed out directly.
  RECEIVED: {
    TRIAGE: 'ACTION_NEEDED',
    SCHEDULE: 'SCHEDULED',
    COMPLETE_STEP: 'WAITING',
    RESOLVE: 'DONE',
    DISMISS: 'DISMISSED',
  },
  ACTION_NEEDED: {
    SCHEDULE: 'SCHEDULED',
    COMPLETE_STEP: 'WAITING',
    RESOLVE: 'DONE',
    DISMISS: 'DISMISSED',
  },
  SCHEDULED: {
    COMPLETE_STEP: 'WAITING',
    RESOLVE: 'DONE',
    DISMISS: 'DISMISSED',
  },
  // WAITING (their move) can flip back to SCHEDULED when their reply is a
  // concrete time; COMPLETE_STEP from WAITING is meaningless (nothing of
  // ours is in flight to complete).
  WAITING: {
    SCHEDULE: 'SCHEDULED',
    RESOLVE: 'DONE',
    DISMISS: 'DISMISSED',
  },
  DONE: {
    REOPEN: 'ACTION_NEEDED',
  },
  DISMISSED: {
    REOPEN: 'ACTION_NEEDED',
  },
};

/**
 * Returns the next state for `event` from `state`, or throws
 * InvalidFollowupTransitionError when the transition is not allowed.
 */
export function followupTransition(
  state: FollowupState,
  event: FollowupEvent,
): FollowupState {
  const next = FOLLOWUP_ALLOWED[state][event];
  if (next === undefined) {
    throw new InvalidFollowupTransitionError(state, event);
  }
  return next;
}

/** Returns true when `event` is allowed from `state`. */
export function canFollowupTransition(
  state: FollowupState,
  event: FollowupEvent,
): boolean {
  return FOLLOWUP_ALLOWED[state][event] !== undefined;
}

/**
 * The non-terminal states — a follow-up in one of these is still live:
 * it participates in calendar sync and the midnight deadline alerts.
 */
export const OPEN_FOLLOWUP_STATES: readonly FollowupState[] = [
  'RECEIVED',
  'ACTION_NEEDED',
  'SCHEDULED',
  'WAITING',
];

/** Display labels for each state (dashboard UI + api agree via this map). */
export const FOLLOWUP_STATE_LABELS: Record<FollowupState, string> = {
  RECEIVED: 'Received',
  ACTION_NEEDED: 'Action needed',
  SCHEDULED: 'Scheduled',
  WAITING: 'Waiting',
  DONE: 'Done',
  DISMISSED: 'Dismissed',
};

/** Display labels for each event (the dashboard's action buttons). */
export const FOLLOWUP_EVENT_LABELS: Record<FollowupEvent, string> = {
  TRIAGE: 'Triage',
  SCHEDULE: 'Schedule',
  COMPLETE_STEP: 'Complete step',
  RESOLVE: 'Resolve',
  DISMISS: 'Dismiss',
  REOPEN: 'Reopen',
};

/** Display labels for each kind (dashboard chips + email-ingest titles). */
export const FOLLOWUP_KIND_LABELS: Record<FollowupKind, string> = {
  assessment: 'Assessment',
  interview: 'Interview',
  recruiter: 'Recruiter',
  offer: 'Offer',
  rejection: 'Rejection',
  other: 'Other',
};
