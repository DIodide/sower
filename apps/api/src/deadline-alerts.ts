import type { TaskState } from '@sower/core';
import { applicationTasks, events, jobs } from '@sower/db';
import { and, eq, inArray, isNotNull, notInArray, or } from 'drizzle-orm';
import {
  type CalendarReconcileResult,
  reconcileCalendarEvents,
} from './calendar-sync.js';
import { escapeLabel, shortenUrlForLabel } from './discord-ingest.js';
import type { Deps } from './types.js';

/**
 * Deadline alerts: at ET midnight the scheduler POSTs /alerts/deadlines,
 * which pings the user in the #alerts channel for every task whose effective
 * deadline falls TODAY (America/New_York). Fully dormant until infra sets
 * DISCORD_ALERTS_CHANNEL_ID (like DISCORD_INGEST_CHANNEL_ID).
 *
 * The dispatch itself lives behind ONE seam — `sendDeadlineAlert` — so a
 * future transport (iMessage, email, …) is a change inside that single
 * function, never a framework.
 */

/** Event type recorded per alert; its data.date is the alert's ET date. */
export const DEADLINE_ALERT_EVENT = 'DEADLINE_ALERT';

/** States a deadline no longer means anything for: sent, or archived. */
const EXCLUDED_STATES: readonly TaskState[] = [
  'SUBMITTED',
  'CONFIRMED',
  'DISCARDED',
  'DUPLICATE',
];

/** Discord hard-caps messages at 2000 chars. */
const DISCORD_MESSAGE_MAX_CHARS = 2000;

// en-CA renders YYYY-MM-DD — the stable, comparable calendar-date form.
const EASTERN_DATE_ISO = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/**
 * The America/New_York CALENDAR DATE (`2026-07-18`) an instant falls on —
 * the alert fires on the ET day the deadline instant belongs to. Two storage
 * shapes flow in: date-only values normalized by deadlineFromIsoDate sit at
 * ET MIDNIGHT of the named day (`2026-07-20T04:00Z` → July 20 — the day the
 * user meant), while free-text-parsed deadlines (extractDeadline) and legacy
 * rows sit at UTC midnight, which is the previous EVENING in ET
 * (`2026-07-19T00:00Z` → July 18 — the instant passes during ET July 18, so
 * the midnight-ET alert still precedes it).
 */
export function easternDateOf(date: Date): string {
  return EASTERN_DATE_ISO.format(date);
}

/** One due-today task, joined with its job — what the alert renders. */
export interface DeadlineAlertTask {
  taskId: string;
  state: string;
  company: string | null;
  title: string | null;
  /** The job's posting URL (the `[posting](…)` link). */
  url: string;
  /** Effective deadline: `application_tasks.due_date` if set, else `jobs.deadline`. */
  deadline: Date;
}

export interface DeadlineAlertsResult {
  enabled: boolean;
  /** Tasks whose effective deadline falls today (ET). */
  due: number;
  /** Alerts actually posted (and recorded as DEADLINE_ALERT events). */
  alerted: number;
  /** Due tasks not alerted: already alerted today, or the send failed. */
  skipped: number;
  /** Google Calendar reconcile sweep (self-gated; rides the same run). */
  calendar: CalendarReconcileResult;
}

/** Plain-words status phrase for the alert line (mirrors the dashboard's). */
const STATUS_PHRASES: Record<string, string> = {
  NEEDS_INPUT: 'needs your answers',
  REVIEW: 'ready for your review',
  AWAITING_OTP: 'waiting on the email code',
  FAILED: 'failed — needs a retry',
};

function statusPhrase(state: string): string {
  return STATUS_PHRASES[state] ?? 'in the pipeline';
}

/**
 * `Company — Role` with the ingest reply's fallback ladder: both parts →
 * the lone known part → the shortened job URL. Never the task UUID.
 * Markdown-escaped so a title can't corrupt the surrounding message.
 */
function alertLabel(task: DeadlineAlertTask): string {
  const company = task.company?.trim();
  const title = task.title?.trim();
  const label =
    company && title
      ? `${company} — ${title}`
      : company || title || shortenUrlForLabel(task.url);
  return escapeLabel(label);
}

/**
 * The alert message:
 * `<@id> ⏰ Due today: **Company — Role** — <status phrase> ·
 *  [open in sower](<dashboard>/tasks/<id>) · [posting](<job url>)`
 * Each optional segment degrades gracefully — the mention when no user id is
 * configured, the dashboard link when no base URL, the posting link for
 * non-http URLs (manual:// placeholders). Always under Discord's 2000 cap.
 */
function formatDeadlineAlert(
  task: DeadlineAlertTask,
  config: Deps['config'],
): string {
  const mention = config.DISCORD_ALERT_MENTION_USER_ID
    ? `<@${config.DISCORD_ALERT_MENTION_USER_ID}> `
    : '';
  const parts = [
    `${mention}⏰ Due today: **${alertLabel(task)}** — ${statusPhrase(task.state)}`,
  ];
  if (config.DASHBOARD_BASE_URL) {
    const base = config.DASHBOARD_BASE_URL.replace(/\/+$/, '');
    parts.push(`[open in sower](${base}/tasks/${task.taskId})`);
  }
  if (/^https?:\/\//i.test(task.url)) {
    parts.push(`[posting](${task.url})`);
  }
  const text = parts.join(' · ');
  return text.length > DISCORD_MESSAGE_MAX_CHARS
    ? `${text.slice(0, DISCORD_MESSAGE_MAX_CHARS - 1)}…`
    : text;
}

/**
 * THE transport seam: deliver one deadline alert for a due-today task.
 * Discord (#alerts channel) is the only transport today; when others arrive
 * (iMessage, …) they are added INSIDE this one function — callers never know
 * which transport fired. Throws on failure so the caller's per-task
 * try/catch keeps the batch tolerant.
 */
export async function sendDeadlineAlert(
  deps: Deps,
  task: DeadlineAlertTask,
): Promise<void> {
  const { notify, config } = deps;
  const channelId = config.DISCORD_ALERTS_CHANNEL_ID;
  if (!notify || !config.DISCORD_ENABLED || !channelId) {
    throw new Error('deadline alerts are not configured (no Discord channel)');
  }
  await notify.postChannelMessage(channelId, formatDeadlineAlert(task, config));
}

/**
 * The midnight-ET run: post the Discord due-today alerts, then run the
 * Google Calendar reconcile sweep on the SAME schedule (each half self-gates
 * on its own config, so either can be live without the other). `now` is
 * injectable for tests; the endpoint always uses the server clock.
 */
export async function runDeadlineAlerts(
  deps: Deps,
  now: Date = new Date(),
): Promise<DeadlineAlertsResult> {
  const alerts = await runDiscordDeadlineAlerts(deps, now);
  // Never throws (self-gated + fully caught inside): the sweep backfills
  // events for tasks dated before the sync existed and heals any drift a
  // failed trigger-point sync left behind.
  const calendar = await reconcileCalendarEvents(deps, now);
  return { ...alerts, calendar };
}

/**
 * Find every task due TODAY (America/New_York), alert each once, and record
 * a DEADLINE_ALERT event per alert. No-op `{enabled:false}` until Discord +
 * the alerts channel are configured. Per-task tolerant: one failed send is
 * logged and counted as skipped, never stops the batch.
 */
async function runDiscordDeadlineAlerts(
  deps: Deps,
  now: Date,
): Promise<Omit<DeadlineAlertsResult, 'calendar'>> {
  const { db, config, notify } = deps;
  if (!config.DISCORD_ENABLED || !config.DISCORD_ALERTS_CHANNEL_ID || !notify) {
    return { enabled: false, due: 0, alerted: 0, skipped: 0 };
  }
  const today = easternDateOf(now);

  // Candidates: actionable tasks carrying ANY deadline. The date comparison
  // happens in JS (the ET calendar-date conversion has no clean SQL form),
  // and the state exclusion is re-checked there too as a belt.
  const rows = await db
    .select({
      taskId: applicationTasks.id,
      state: applicationTasks.state,
      dueDate: applicationTasks.dueDate,
      deadline: jobs.deadline,
      company: jobs.company,
      title: jobs.title,
      url: jobs.url,
    })
    .from(applicationTasks)
    .innerJoin(jobs, eq(applicationTasks.jobId, jobs.id))
    .where(
      and(
        notInArray(applicationTasks.state, [...EXCLUDED_STATES]),
        or(isNotNull(applicationTasks.dueDate), isNotNull(jobs.deadline)),
      ),
    );

  const due: DeadlineAlertTask[] = [];
  for (const row of rows) {
    if ((EXCLUDED_STATES as string[]).includes(row.state)) {
      continue;
    }
    // Effective deadline: the user's own due date wins over the posting's
    // parsed deadline — the same precedence the dashboard displays.
    const deadline = row.dueDate ?? row.deadline;
    if (!deadline || easternDateOf(deadline) !== today) {
      continue;
    }
    due.push({
      taskId: row.taskId,
      state: row.state,
      company: row.company,
      title: row.title,
      url: row.url,
      deadline,
    });
  }
  if (due.length === 0) {
    return { enabled: true, due: 0, alerted: 0, skipped: 0 };
  }

  // Dedupe: a task already carrying a DEADLINE_ALERT event whose data.date
  // is today's ET date was alerted by an earlier run (scheduler retry,
  // manual re-POST) and is skipped — one ping per task per day.
  const alertEvents = await db
    .select({ taskId: events.taskId, data: events.data })
    .from(events)
    .where(
      and(
        eq(events.type, DEADLINE_ALERT_EVENT),
        inArray(
          events.taskId,
          due.map((task) => task.taskId),
        ),
      ),
    );
  const alreadyAlerted = new Set(
    alertEvents
      .filter(
        (event) => (event.data as { date?: unknown } | null)?.date === today,
      )
      .map((event) => event.taskId),
  );

  let alerted = 0;
  let skipped = 0;
  for (const task of due) {
    if (alreadyAlerted.has(task.taskId)) {
      skipped += 1;
      continue;
    }
    try {
      await sendDeadlineAlert(deps, task);
      // Recorded AFTER the send: a failed send leaves no event, so the next
      // run retries; a failed event write can at worst re-ping once.
      await db.insert(events).values({
        taskId: task.taskId,
        type: DEADLINE_ALERT_EVENT,
        data: { date: today, channel: 'discord' },
      });
      alerted += 1;
    } catch (error) {
      skipped += 1;
      console.warn(
        `[sower] deadline alert failed for task ${task.taskId}:`,
        error,
      );
    }
  }
  return { enabled: true, due: due.length, alerted, skipped };
}
