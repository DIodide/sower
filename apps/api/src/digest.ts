import {
  type FollowupKind,
  type FollowupState,
  OPEN_FOLLOWUP_STATES,
  type TaskPriority,
  type TaskState,
} from '@sower/core';
import { applicationTasks, events, followups, jobs } from '@sower/db';
import { GmailSendScopeError, sendGmailMessage } from '@sower/inbox';
import { and, eq, gte, inArray, isNotNull, notInArray, or } from 'drizzle-orm';
import { easternDateOf } from './deadline-alerts.js';
import { renderDigestDiscord, renderDigestEmail } from './digest-render.js';
import type { Db, Deps } from './types.js';

/**
 * Weekly digest: one Cloud Scheduler POST /digest/weekly builds a snapshot
 * of the pipeline's trailing week (+ the week of deadlines ahead) ONCE, then
 * delivers it over two independent legs — the Discord digest channel and a
 * Gmail-sent email. Every query here is READ-ONLY: unlike the deadline
 * alerts there is no per-item dedupe event, so a re-POST simply re-sends
 * the same digest and mutates nothing.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
/** Trailing window and the deadline horizon ahead: one week. */
const WEEK_MS = 7 * DAY_MS;

/** States a deadline no longer means anything for (mirrors deadline-alerts). */
const EXCLUDED_DEADLINE_STATES: readonly TaskState[] = [
  'SUBMITTED',
  'CONFIRMED',
  'DISCARDED',
  'DUPLICATE',
];

/** The "waiting on you" states the digest reports (dashboard's core pair). */
const WAITING_STATES: readonly TaskState[] = ['NEEDS_INPUT', 'REVIEW'];

/** A NEEDS_INPUT task untouched longer than this is going stale. */
const STALE_AFTER_MS = WEEK_MS;

/** How many waiting tasks the digest itemizes (the dashboard's top slice). */
const WAITING_TOP_COUNT = 5;

/** How many stale tasks the digest itemizes (the oldest ones). */
const STALE_OLDEST_COUNT = 3;

/** One application that entered SUBMITTED/CONFIRMED this week. */
export interface DigestSubmittedItem {
  taskId: string;
  company: string | null;
  title: string | null;
  /** When it entered (the transition event's timestamp). */
  at: Date;
}

/** One waiting task, ranked by the dashboard's priority-then-newest order. */
export interface DigestWaitingItem {
  taskId: string;
  company: string | null;
  title: string | null;
  priority: TaskPriority;
  /** Effective deadline: due_date override else posting deadline; null = none. */
  due: Date | null;
}

/** One deadline in the week ahead — a task's or an open follow-up's. */
export interface DigestDeadlineItem {
  kind: 'task' | 'followup';
  /** The task id or the followup id, matching `kind`. */
  id: string;
  company: string | null;
  /** The job title for tasks, the follow-up's own title for follow-ups. */
  title: string | null;
  due: Date;
}

/** One open follow-up (grouped by state under inPlay.byState). */
export interface DigestInPlayItem {
  followupId: string;
  kind: FollowupKind;
  company: string | null;
  title: string;
}

/** One going-stale NEEDS_INPUT task. */
export interface DigestStaleItem {
  taskId: string;
  company: string | null;
  title: string | null;
  /** Whole days since the task was last touched (updated_at). */
  days: number;
}

export interface WeeklyDigest {
  /** The instant the digest was built for (renders as its ET date). */
  now: Date;
  /** Applications that ENTERED SUBMITTED/CONFIRMED in the trailing week. */
  submitted: { count: number; items: DigestSubmittedItem[] };
  /** Tasks created in the trailing week + how many were auto-discarded. */
  ingested: { created: number; autoDiscarded: number };
  /** Current NEEDS_INPUT/REVIEW backlog + its top slice. */
  waiting: { count: number; top: DigestWaitingItem[] };
  /** Tasks + open follow-ups due in the next 7 ET days, soonest first. */
  deadlines: DigestDeadlineItem[];
  /** Open follow-ups, grouped by their state. */
  inPlay: {
    count: number;
    byState: Partial<Record<FollowupState, DigestInPlayItem[]>>;
  };
  /** NEEDS_INPUT tasks untouched for over a week — count + the oldest. */
  stale: { count: number; oldest: DigestStaleItem[] };
}

/**
 * Build the digest for the trailing 7 days (and the 7 ET days of deadlines
 * ahead — same easternDateOf calendar-date semantics the midnight alerts
 * use). Read-only; `now` is injectable for tests.
 */
export async function buildWeeklyDigest(
  db: Db,
  now: Date,
): Promise<WeeklyDigest> {
  const since = new Date(now.getTime() - WEEK_MS);
  // ET calendar-date horizon for "this week's deadlines": today (ET) up to
  // but not including the same date next week. en-CA YYYY-MM-DD strings
  // compare correctly as strings, so no date math is needed per row.
  const todayEt = easternDateOf(now);
  const horizonEt = easternDateOf(new Date(now.getTime() + WEEK_MS));

  // Submitted: entering SUBMITTED/CONFIRMED is recorded on the transition
  // event's to_state (SUBMIT_OK/MARK_SUBMITTED → SUBMITTED, CONFIRM →
  // CONFIRMED — the @sower/core transition table), so the events table is
  // the source of truth. Window + entering state are re-checked in JS as a
  // belt; the CURRENT task state filters out later reversals
  // (UNMARK_SUBMITTED); a task entering twice (SUBMITTED then CONFIRMED)
  // counts once, at its earliest entry.
  const submittedRows = await db
    .select({
      taskId: events.taskId,
      toState: events.toState,
      at: events.createdAt,
      state: applicationTasks.state,
      company: jobs.company,
      title: jobs.title,
    })
    .from(events)
    .innerJoin(applicationTasks, eq(events.taskId, applicationTasks.id))
    .innerJoin(jobs, eq(applicationTasks.jobId, jobs.id))
    .where(
      and(
        inArray(events.toState, ['SUBMITTED', 'CONFIRMED']),
        gte(events.createdAt, since),
      ),
    );
  const submittedByTask = new Map<string, DigestSubmittedItem>();
  for (const row of submittedRows) {
    if (!row.at || row.at < since) {
      continue;
    }
    if (row.toState !== 'SUBMITTED' && row.toState !== 'CONFIRMED') {
      continue;
    }
    if (row.state !== 'SUBMITTED' && row.state !== 'CONFIRMED') {
      continue;
    }
    const existing = submittedByTask.get(row.taskId);
    if (!existing || row.at < existing.at) {
      submittedByTask.set(row.taskId, {
        taskId: row.taskId,
        company: row.company,
        title: row.title,
        at: row.at,
      });
    }
  }
  const submittedItems = [...submittedByTask.values()].sort(
    (a, b) => a.at.getTime() - b.at.getTime(),
  );

  // Ingested: tasks created in-window …
  const createdRows = await db
    .select({ createdAt: applicationTasks.createdAt })
    .from(applicationTasks)
    .where(gte(applicationTasks.createdAt, since));
  const created = createdRows.filter(
    (row) => row.createdAt && row.createdAt >= since,
  ).length;

  // … and how many were auto-discarded. There is no separate event type:
  // an auto-discard is a DISCARD event with data.reason 'auto' (the
  // full-time filter in process.ts and listing expansion both write that
  // shape; a human discard carries reason 'manual').
  const discardRows = await db
    .select({ data: events.data, at: events.createdAt })
    .from(events)
    .where(and(eq(events.type, 'DISCARD'), gte(events.createdAt, since)));
  const autoDiscarded = discardRows.filter(
    (row) =>
      row.at !== null &&
      row.at >= since &&
      (row.data as { reason?: unknown } | null)?.reason === 'auto',
  ).length;

  // Waiting on you: the current NEEDS_INPUT/REVIEW backlog, ranked by the
  // dashboard's tier order — priority desc, then newest first (rank.ts).
  // This one select also feeds the stale section below.
  const waitingRows = await db
    .select({
      taskId: applicationTasks.id,
      state: applicationTasks.state,
      priority: applicationTasks.priority,
      createdAt: applicationTasks.createdAt,
      updatedAt: applicationTasks.updatedAt,
      dueDate: applicationTasks.dueDate,
      deadline: jobs.deadline,
      company: jobs.company,
      title: jobs.title,
    })
    .from(applicationTasks)
    .innerJoin(jobs, eq(applicationTasks.jobId, jobs.id))
    .where(inArray(applicationTasks.state, [...WAITING_STATES]));
  const waiting = waitingRows.filter((row) =>
    (WAITING_STATES as string[]).includes(row.state),
  );
  const waitingTop = [...waiting]
    .sort(
      (a, b) =>
        b.priority - a.priority ||
        (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0),
    )
    .slice(0, WAITING_TOP_COUNT)
    .map((row) => ({
      taskId: row.taskId,
      company: row.company,
      title: row.title,
      priority: row.priority,
      // Effective deadline: the user's due date wins over the posting's.
      due: row.dueDate ?? row.deadline,
    }));

  // Going stale: NEEDS_INPUT rows untouched for over a week, oldest first.
  const staleRows = waiting
    .filter(
      (row) =>
        row.state === 'NEEDS_INPUT' &&
        row.updatedAt !== null &&
        now.getTime() - row.updatedAt.getTime() > STALE_AFTER_MS,
    )
    .sort(
      (a, b) => (a.updatedAt?.getTime() ?? 0) - (b.updatedAt?.getTime() ?? 0),
    );
  const stale = {
    count: staleRows.length,
    oldest: staleRows.slice(0, STALE_OLDEST_COUNT).map((row) => ({
      taskId: row.taskId,
      company: row.company,
      title: row.title,
      days: Math.floor(
        (now.getTime() - (row.updatedAt?.getTime() ?? now.getTime())) / DAY_MS,
      ),
    })),
  };

  // Deadlines this week, task half: actionable tasks whose EFFECTIVE
  // deadline (due_date override else posting deadline — exactly the
  // deadline-alerts precedence) falls on an ET date within the horizon.
  const deadlineTaskRows = await db
    .select({
      taskId: applicationTasks.id,
      state: applicationTasks.state,
      dueDate: applicationTasks.dueDate,
      deadline: jobs.deadline,
      company: jobs.company,
      title: jobs.title,
    })
    .from(applicationTasks)
    .innerJoin(jobs, eq(applicationTasks.jobId, jobs.id))
    .where(
      and(
        notInArray(applicationTasks.state, [...EXCLUDED_DEADLINE_STATES]),
        or(isNotNull(applicationTasks.dueDate), isNotNull(jobs.deadline)),
      ),
    );
  const deadlines: DigestDeadlineItem[] = [];
  for (const row of deadlineTaskRows) {
    if ((EXCLUDED_DEADLINE_STATES as string[]).includes(row.state)) {
      continue;
    }
    const due = row.dueDate ?? row.deadline;
    if (!due) {
      continue;
    }
    const dueEt = easternDateOf(due);
    if (dueEt < todayEt || dueEt >= horizonEt) {
      continue;
    }
    deadlines.push({
      kind: 'task',
      id: row.taskId,
      company: row.company,
      title: row.title,
      due,
    });
  }

  // Open follow-ups, joined with the parent job for the company. One select
  // feeds BOTH the in-play grouping and the follow-up half of deadlines.
  const followupRows = await db
    .select({
      followupId: followups.id,
      kind: followups.kind,
      title: followups.title,
      state: followups.state,
      dueDate: followups.dueDate,
      company: jobs.company,
    })
    .from(followups)
    .innerJoin(applicationTasks, eq(followups.taskId, applicationTasks.id))
    .innerJoin(jobs, eq(applicationTasks.jobId, jobs.id))
    .where(inArray(followups.state, [...OPEN_FOLLOWUP_STATES]));
  const byState: Partial<Record<FollowupState, DigestInPlayItem[]>> = {};
  let inPlayCount = 0;
  for (const row of followupRows) {
    if (!(OPEN_FOLLOWUP_STATES as string[]).includes(row.state)) {
      continue;
    }
    inPlayCount += 1;
    const group = byState[row.state] ?? [];
    group.push({
      followupId: row.followupId,
      kind: row.kind,
      company: row.company,
      title: row.title,
    });
    byState[row.state] = group;
    if (row.dueDate) {
      const dueEt = easternDateOf(row.dueDate);
      if (dueEt >= todayEt && dueEt < horizonEt) {
        deadlines.push({
          kind: 'followup',
          id: row.followupId,
          company: row.company,
          title: row.title,
          due: row.dueDate,
        });
      }
    }
  }
  deadlines.sort((a, b) => a.due.getTime() - b.due.getTime());

  return {
    now,
    submitted: { count: submittedItems.length, items: submittedItems },
    ingested: { created, autoDiscarded },
    waiting: { count: waiting.length, top: waitingTop },
    deadlines,
    inPlay: { count: inPlayCount, byState },
    stale,
  };
}

/** Per-leg outcome: 'sent', or a reason-carrying skip/failure phrase. */
export type DigestLegOutcome = string;

export interface WeeklyDigestRunResult {
  discord: DigestLegOutcome;
  email: DigestLegOutcome;
  /** Headline counts (the route's summary — never the full digest). */
  week: {
    submitted: number;
    ingested: number;
    deadlines: number;
    inPlay: number;
  };
}

/**
 * Discord leg: post the rendered digest to the digest channel. Self-gates
 * on Discord + the channel id; a send failure is logged and reported in the
 * outcome string, never thrown — the email leg must still run.
 */
async function sendDigestToDiscord(
  deps: Deps,
  digest: WeeklyDigest,
): Promise<DigestLegOutcome> {
  const { notify, config } = deps;
  const channelId = config.DISCORD_DIGEST_CHANNEL_ID;
  if (!notify || !config.DISCORD_ENABLED || !channelId) {
    return 'skipped: no Discord digest channel configured';
  }
  try {
    await notify.postChannelMessage(
      channelId,
      renderDigestDiscord(digest, config.DASHBOARD_BASE_URL),
    );
    return 'sent';
  } catch (error) {
    console.warn('[sower] weekly digest Discord post failed:', error);
    return `failed: ${error instanceof Error ? error.message : 'Discord post failed'}`;
  }
}

/**
 * Email leg: render + send via Gmail. Self-gates on the recipient and the
 * Gmail OAuth triple. A 403 scope refusal (the reader's readonly token
 * can't send) reports as a SKIP with the actionable reason; anything else
 * is logged and reported as a failure — never thrown.
 */
async function sendDigestEmail(
  config: Deps['config'],
  digest: WeeklyDigest,
  fetchImpl: typeof fetch,
): Promise<DigestLegOutcome> {
  const to = config.DIGEST_EMAIL_TO;
  if (!to) {
    return 'skipped: no digest email recipient configured';
  }
  if (
    !config.GMAIL_CLIENT_ID ||
    !config.GMAIL_CLIENT_SECRET ||
    !config.GMAIL_REFRESH_TOKEN
  ) {
    return 'skipped: Gmail OAuth is not configured';
  }
  try {
    await sendGmailMessage(
      {
        clientId: config.GMAIL_CLIENT_ID,
        clientSecret: config.GMAIL_CLIENT_SECRET,
        refreshToken: config.GMAIL_REFRESH_TOKEN,
      },
      { to, ...renderDigestEmail(digest) },
      fetchImpl,
    );
    return 'sent';
  } catch (error) {
    if (error instanceof GmailSendScopeError) {
      console.warn('[sower] weekly digest email skipped:', error.message);
      return 'skipped: token lacks send scope';
    }
    console.warn('[sower] weekly digest email failed:', error);
    return `failed: ${error instanceof Error ? error.message : 'email send failed'}`;
  }
}

/**
 * The weekly run: build the digest once, then deliver each leg
 * independently — one leg's failure never blocks the other, and the caller
 * (the route) always 200s with the two outcome strings + headline counts.
 * `now`/`fetchImpl` are injectable for tests; the endpoint uses the server
 * clock and global fetch.
 */
export async function runWeeklyDigest(
  deps: Deps,
  now: Date = new Date(),
  fetchImpl: typeof fetch = fetch,
): Promise<WeeklyDigestRunResult> {
  let digest: WeeklyDigest;
  try {
    digest = await buildWeeklyDigest(deps.db, now);
  } catch (error) {
    // The route's contract is an unconditional 200 — a broken build is
    // logged and reported on both legs instead of thrown.
    console.warn('[sower] weekly digest build failed:', error);
    return {
      discord: 'failed: digest build failed',
      email: 'failed: digest build failed',
      week: { submitted: 0, ingested: 0, deadlines: 0, inPlay: 0 },
    };
  }
  const discord = await sendDigestToDiscord(deps, digest);
  const email = await sendDigestEmail(deps.config, digest, fetchImpl);
  return {
    discord,
    email,
    week: {
      submitted: digest.submitted.count,
      ingested: digest.ingested.created,
      deadlines: digest.deadlines.length,
      inPlay: digest.inPlay.count,
    },
  };
}
