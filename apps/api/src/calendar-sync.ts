import type { TaskState } from '@sower/core';
import { applicationTasks, jobs } from '@sower/db';
import { eq, isNotNull, or } from 'drizzle-orm';
import { shortenUrlForLabel } from './discord-ingest.js';
import type { Deps } from './types.js';

/**
 * Google Calendar deadline sync: every task with an EFFECTIVE deadline (the
 * user's due_date if set, else jobs.deadline — the dashboard's precedence)
 * carries one calendar event on the OAuth user's primary calendar, with the
 * secondary account invited as an attendee so both calendars show it. Built
 * on plain fetch exactly like @sower/inbox's gmail.ts — same OAuth client
 * (GMAIL_CLIENT_ID/SECRET), its own refresh token
 * (GOOGLE_CALENDAR_REFRESH_TOKEN, scope calendar.events), access tokens
 * minted per ~55 minutes and cached per process.
 *
 * Fully dormant until all three env vars are present (the derived
 * config.CALENDAR_SYNC_ENABLED); every entry point is best-effort and NEVER
 * throws — a Calendar/API hiccup must not fail the user action that
 * triggered it.
 */

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const CALENDAR_BASE = 'https://www.googleapis.com/calendar/v3';
/** The OAuth user's own calendar (ibraheem.amin2@gmail.com). */
const CALENDAR_ID = 'primary';
/** Invited on every event so the school account's calendar shows it too. */
export const CALENDAR_ATTENDEE_EMAIL = 'ibraheem@princeton.edu';
/** Refresh 5 minutes before Google's ~60-minute expiry (mirrors gmail.ts). */
const TOKEN_SLACK_MS = 5 * 60_000;

/** Reconcile sweep cap per midnight run (backfill drains over a few days). */
export const RECONCILE_MAX_PER_RUN = 50;

/**
 * States a deadline no longer means anything for — same list the deadline
 * alerts exclude (sent, or archived): their events are deleted, not kept.
 */
const EXCLUDED_STATES: readonly TaskState[] = [
  'SUBMITTED',
  'CONFIRMED',
  'DISCARDED',
  'DUPLICATE',
];

const EASTERN_TIME_ZONE = 'America/New_York';

// en-CA renders YYYY-MM-DD — the stable, comparable calendar-date form
// (mirrors deadline-alerts.ts's easternDateOf; local so the import graph
// stays one-directional: deadline-alerts imports this module's reconcile).
const EASTERN_DATE_ISO = new Intl.DateTimeFormat('en-CA', {
  timeZone: EASTERN_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

// hourCycle 'h23' renders midnight as 00, so ET midnight reads '00:00:00'.
const EASTERN_TIME = new Intl.DateTimeFormat('en-GB', {
  timeZone: EASTERN_TIME_ZONE,
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

/** The America/New_York calendar date (`2026-07-20`) an instant falls on. */
function easternDateOf(instant: Date): string {
  return EASTERN_DATE_ISO.format(instant);
}

/**
 * True when the instant is EXACTLY midnight America/New_York — the storage
 * shape deadlineFromIsoDate gives every date-only deadline (`2026-07-20` →
 * `2026-07-20T04:00Z` under EDT). Such a value names a whole DAY, not a
 * time, so it renders as an all-day event. Free-text-parsed deadlines and
 * legacy rows sit at UTC midnight (an ET evening) and read as timed.
 */
export function isEasternMidnight(instant: Date): boolean {
  return EASTERN_TIME.format(instant) === '00:00:00';
}

/** `2026-07-20` → `2026-07-21` (UTC arithmetic — immune to DST). */
function nextIsoDate(isoDate: string): string {
  const [year, month, day] = isoDate.split('-').map(Number);
  return new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, (day ?? 1) + 1))
    .toISOString()
    .slice(0, 10);
}

/** Google Calendar event start/end, either all-day (date) or timed. */
export interface CalendarEventTimes {
  start: { date: string } | { dateTime: string; timeZone: string };
  end: { date: string } | { dateTime: string; timeZone: string };
}

/**
 * The event window for a deadline instant:
 * - ET-midnight instants are DATE-ONLY deadlines → an ALL-DAY event on that
 *   ET calendar date (end.date is exclusive per the Calendar API, so +1 day).
 * - Anything else carries a real time → a one-hour block ENDING at the
 *   deadline instant, rendered in ET.
 */
export function calendarEventTimes(deadline: Date): CalendarEventTimes {
  if (isEasternMidnight(deadline)) {
    const date = easternDateOf(deadline);
    return { start: { date }, end: { date: nextIsoDate(date) } };
  }
  return {
    start: {
      dateTime: new Date(deadline.getTime() - 60 * 60_000).toISOString(),
      timeZone: EASTERN_TIME_ZONE,
    },
    end: { dateTime: deadline.toISOString(), timeZone: EASTERN_TIME_ZONE },
  };
}

/** What the sync needs to render an event (the task+job join projection). */
interface CalendarTaskRow {
  taskId: string;
  state: string;
  dueDate: Date | null;
  calendarEventId: string | null;
  company: string | null;
  title: string | null;
  url: string;
  deadline: Date | null;
}

/**
 * `Company — Role` with the ingest reply's fallback ladder: both parts →
 * the lone known part → the shortened job URL. Never the task UUID. Plain
 * text (no markdown escaping — Calendar summaries are not markdown).
 */
function eventLabel(row: CalendarTaskRow): string {
  const company = row.company?.trim();
  const title = row.title?.trim();
  return company && title
    ? `${company} — ${title}`
    : company || title || shortenUrlForLabel(row.url);
}

/** The full Calendar event body (insert and patch send the same shape). */
export function buildCalendarEvent(
  row: CalendarTaskRow,
  deadline: Date,
  config: Deps['config'],
): Record<string, unknown> {
  const lines: string[] = [];
  if (config.DASHBOARD_BASE_URL) {
    const base = config.DASHBOARD_BASE_URL.replace(/\/+$/, '');
    lines.push(`Task: ${base}/tasks/${row.taskId}`);
  }
  if (/^https?:\/\//i.test(row.url)) {
    lines.push(`Posting: ${row.url}`);
  }
  return {
    summary: `⏰ ${eventLabel(row)} application due`,
    description: lines.join('\n'),
    ...calendarEventTimes(deadline),
    attendees: [{ email: CALENDAR_ATTENDEE_EMAIL }],
    reminders: { useDefault: true },
  };
}

// Per-process access-token cache, exactly like gmail.ts's instance cache
// (module-level because the sync is plain functions, not a class).
let cachedAccessToken: string | null = null;
let cachedAccessTokenExpiresAt = 0;

/** Test seam: drop the cached access token (fresh mint on next call). */
export function resetCalendarTokenCache(): void {
  cachedAccessToken = null;
  cachedAccessTokenExpiresAt = 0;
}

async function calendarAccessToken(
  config: Deps['config'],
  fetchImpl: typeof fetch,
): Promise<string> {
  if (cachedAccessToken && Date.now() < cachedAccessTokenExpiresAt) {
    return cachedAccessToken;
  }
  const res = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.GMAIL_CLIENT_ID ?? '',
      client_secret: config.GMAIL_CLIENT_SECRET ?? '',
      refresh_token: config.GOOGLE_CALENDAR_REFRESH_TOKEN ?? '',
      grant_type: 'refresh_token',
    }).toString(),
  });
  if (!res.ok) {
    throw new Error(
      `calendar token refresh failed with status ${res.status} (re-mint google-calendar-refresh-token if it was revoked)`,
    );
  }
  const body = (await res.json()) as {
    access_token: string;
    expires_in?: number;
  };
  cachedAccessToken = body.access_token;
  cachedAccessTokenExpiresAt =
    Date.now() + (body.expires_in ?? 3600) * 1000 - TOKEN_SLACK_MS;
  return cachedAccessToken;
}

/** `sendUpdates=all` on every mutation keeps the attendee's copy in sync. */
function eventUrl(eventId?: string): string {
  const base = `${CALENDAR_BASE}/calendars/${CALENDAR_ID}/events`;
  return eventId
    ? `${base}/${encodeURIComponent(eventId)}?sendUpdates=all`
    : `${base}?sendUpdates=all`;
}

export type CalendarSyncOutcome =
  | { kind: 'disabled' }
  | { kind: 'not_found' }
  /** Nothing to do: no event desired and none stored. */
  | { kind: 'noop' }
  | { kind: 'created'; eventId: string }
  | { kind: 'updated'; eventId: string }
  /** The stored event was gone (user deleted it) — a fresh one replaced it. */
  | { kind: 'recreated'; eventId: string }
  | { kind: 'deleted' }
  | { kind: 'error'; error: string };

/**
 * Bring ONE task's calendar event in line with its current effective
 * deadline + state:
 * - no effective deadline, or a sent/archived state → NO event (delete any
 *   stored one, null the column);
 * - otherwise upsert: PATCH when an event id is stored (recreating on 404 —
 *   the user deleted it from their calendar), INSERT when none is.
 *
 * NEVER throws — every failure is logged and reported as {kind:'error'} so
 * the triggering user action (meta save, discard, process run) is untouched.
 * `fetchImpl` is a test seam; production always uses global fetch.
 */
export async function syncTaskCalendarEvent(
  deps: Deps,
  taskId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<CalendarSyncOutcome> {
  const { db, config } = deps;
  if (!config.CALENDAR_SYNC_ENABLED) {
    return { kind: 'disabled' };
  }
  try {
    const rows = await db
      .select({
        taskId: applicationTasks.id,
        state: applicationTasks.state,
        dueDate: applicationTasks.dueDate,
        calendarEventId: applicationTasks.calendarEventId,
        company: jobs.company,
        title: jobs.title,
        url: jobs.url,
        deadline: jobs.deadline,
      })
      .from(applicationTasks)
      .innerJoin(jobs, eq(applicationTasks.jobId, jobs.id))
      .where(eq(applicationTasks.id, taskId))
      .limit(1);
    const row = rows[0];
    if (!row) {
      return { kind: 'not_found' };
    }

    // Effective deadline: the user's own due date wins over the posting's
    // parsed deadline — the dashboard's pickDeadline precedence. Invalid
    // dates are treated as absent.
    const rawDeadline = row.dueDate ?? row.deadline;
    const deadline =
      rawDeadline && !Number.isNaN(rawDeadline.getTime()) ? rawDeadline : null;
    const wantsEvent =
      deadline !== null &&
      !(EXCLUDED_STATES as string[]).includes(row.state as string);

    if (!wantsEvent) {
      if (!row.calendarEventId) {
        return { kind: 'noop' };
      }
      const token = await calendarAccessToken(config, fetchImpl);
      const res = await fetchImpl(eventUrl(row.calendarEventId), {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      // 404/410: already gone (the user beat us to it) — still a success.
      if (!res.ok && res.status !== 404 && res.status !== 410) {
        throw new Error(`calendar event delete failed (${res.status})`);
      }
      await db
        .update(applicationTasks)
        .set({ calendarEventId: null })
        .where(eq(applicationTasks.id, taskId));
      return { kind: 'deleted' };
    }

    const token = await calendarAccessToken(config, fetchImpl);
    const body = JSON.stringify(buildCalendarEvent(row, deadline, config));
    const headers = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    };

    if (row.calendarEventId) {
      const patchRes = await fetchImpl(eventUrl(row.calendarEventId), {
        method: 'PATCH',
        headers,
        body,
      });
      if (patchRes.ok) {
        return { kind: 'updated', eventId: row.calendarEventId };
      }
      // Gone (the user deleted it from their calendar): fall through to a
      // fresh insert. Any other failure is a real error.
      if (patchRes.status !== 404 && patchRes.status !== 410) {
        throw new Error(`calendar event patch failed (${patchRes.status})`);
      }
    }

    const insertRes = await fetchImpl(eventUrl(), {
      method: 'POST',
      headers,
      body,
    });
    if (!insertRes.ok) {
      throw new Error(`calendar event insert failed (${insertRes.status})`);
    }
    const inserted = (await insertRes.json()) as { id?: string };
    if (!inserted.id) {
      throw new Error('calendar event insert returned no id');
    }
    await db
      .update(applicationTasks)
      .set({ calendarEventId: inserted.id })
      .where(eq(applicationTasks.id, taskId));
    return row.calendarEventId
      ? { kind: 'recreated', eventId: inserted.id }
      : { kind: 'created', eventId: inserted.id };
  } catch (error) {
    console.warn(`[sower] calendar sync failed for task ${taskId}:`, error);
    return {
      kind: 'error',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Sync EVERY task on a job — the hook for jobs.deadline changing (a
 * processed discover or an investigation scrape persisted a new posting
 * deadline, which is every task's effective deadline unless a due_date
 * overrides it). Per-task tolerant and never throws.
 */
export async function syncCalendarEventsForJob(
  deps: Deps,
  jobId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  if (!deps.config.CALENDAR_SYNC_ENABLED) {
    return;
  }
  try {
    const rows = await deps.db
      .select({ taskId: applicationTasks.id })
      .from(applicationTasks)
      .where(eq(applicationTasks.jobId, jobId));
    for (const row of rows) {
      await syncTaskCalendarEvent(deps, row.taskId, fetchImpl);
    }
  } catch (error) {
    console.warn(`[sower] calendar sync failed for job ${jobId}:`, error);
  }
}

export interface CalendarReconcileResult {
  enabled: boolean;
  /** Tasks whose stored event id disagrees with the event they should have. */
  candidates: number;
  /** Mismatches actually brought in line this run (capped). */
  synced: number;
}

/**
 * Midnight reconcile sweep (runs with the deadline alerts): find every task
 * whose effective deadline falls TODAY-OR-LATER (ET) and whose stored
 * calendar_event_id disagrees with whether it SHOULD have an event —
 * missing events (the backfill for tasks dated before the sync existed, or
 * a trigger-point sync that failed) and stale events (the task was
 * sent/archived but the delete failed). Caps at RECONCILE_MAX_PER_RUN so a
 * large backfill drains over a few nights instead of hammering the API.
 * Self-gated + never throws, like every other entry point.
 */
export async function reconcileCalendarEvents(
  deps: Deps,
  now: Date = new Date(),
  fetchImpl: typeof fetch = fetch,
): Promise<CalendarReconcileResult> {
  if (!deps.config.CALENDAR_SYNC_ENABLED) {
    return { enabled: false, candidates: 0, synced: 0 };
  }
  try {
    const today = easternDateOf(now);
    const rows = await deps.db
      .select({
        taskId: applicationTasks.id,
        state: applicationTasks.state,
        dueDate: applicationTasks.dueDate,
        calendarEventId: applicationTasks.calendarEventId,
        deadline: jobs.deadline,
      })
      .from(applicationTasks)
      .innerJoin(jobs, eq(applicationTasks.jobId, jobs.id))
      .where(or(isNotNull(applicationTasks.dueDate), isNotNull(jobs.deadline)));

    const mismatched: string[] = [];
    for (const row of rows) {
      const deadline = row.dueDate ?? row.deadline;
      if (!deadline || Number.isNaN(deadline.getTime())) {
        continue;
      }
      // Past deadlines are left alone: their events are history, not drift.
      // YYYY-MM-DD compares lexicographically.
      if (easternDateOf(deadline) < today) {
        continue;
      }
      const shouldHaveEvent = !(EXCLUDED_STATES as string[]).includes(
        row.state as string,
      );
      if ((row.calendarEventId !== null) !== shouldHaveEvent) {
        mismatched.push(row.taskId);
      }
    }

    let synced = 0;
    for (const taskId of mismatched.slice(0, RECONCILE_MAX_PER_RUN)) {
      const outcome = await syncTaskCalendarEvent(deps, taskId, fetchImpl);
      if (outcome.kind !== 'error') {
        synced += 1;
      }
    }
    return { enabled: true, candidates: mismatched.length, synced };
  } catch (error) {
    console.warn('[sower] calendar reconcile sweep failed:', error);
    return { enabled: true, candidates: 0, synced: 0 };
  }
}
