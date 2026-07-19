// Due-date display precedence, shared by the Applications rows and the task
// header: the USER'S own date (application_tasks.due_date, set via the ⏰
// chip / Deadline cell) always wins over the POSTING'S parsed deadline
// (jobs.deadline, never user-editable). Pure so the precedence is
// unit-testable without rendering.

export type DeadlineKind = 'user' | 'posting';

export interface PickedDeadline {
  date: Date;
  /** Which date won: 'user' = the user's own due date, 'posting' = the
   *  deadline parsed from the source. Drives the tooltip wording only —
   *  the chip renders identically for both. */
  kind: DeadlineKind;
}

function asValidDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  const d = typeof value === 'string' ? new Date(value) : value;
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * The date to display: the user's due date when set, else the posting's
 * parsed deadline, else null. Invalid dates are treated as absent.
 */
export function pickDeadline(
  userDueDate: Date | string | null | undefined,
  postingDeadline: Date | string | null | undefined,
): PickedDeadline | null {
  const user = asValidDate(userDueDate);
  if (user) return { date: user, kind: 'user' };
  const posting = asValidDate(postingDeadline);
  if (posting) return { date: posting, kind: 'posting' };
  return null;
}

/**
 * `yyyy-mm-dd` (UTC) for a native `<input type="date">` value — the same
 * calendar date the UTC-midnight timestamp names. Null in = null out.
 */
export function toDateInputValue(
  value: Date | string | null | undefined,
): string | null {
  const d = asValidDate(value);
  return d ? d.toISOString().slice(0, 10) : null;
}
