import type { JobSpec, Platform } from '@sower/core';
import {
  applicationTasks,
  type InvestigationRunKind,
  type InvestigationRunStatus,
  investigationRuns,
  type Job,
  jobs,
} from '@sower/db';
import { getAdapter } from '@sower/platforms';
import { asc, desc, eq, inArray } from 'drizzle-orm';
import {
  formatEasternDate,
  renderReplyLines,
  taskLabel,
  taskLink,
} from './discord-ingest.js';
import { isIngestableJobUrl } from './link-extract.js';
import type { Deps } from './types.js';

/**
 * Re-render a #ingest reply from CURRENT DB state and edit (PATCH) the
 * Discord message, so the reply keeps telling the truth as tasks advance:
 * the investigator Job discovers a form, a human verifies it, and so on.
 *
 * Loop-safe: the edited message keeps the bot as author, so the ingest
 * poll's app-id self-skip still ignores it. Failure-safe: NOTHING in here
 * may throw into the caller — a Discord hiccup must never fail the result
 * or verify endpoints; it is logged and the next refresh retries.
 */

/** The latest investigation run's shape the renderer consults. */
interface LatestRun {
  kind: InvestigationRunKind;
  status: InvestigationRunStatus;
}

/** One announced task, joined with its job, as the reply queries return it. */
interface ReplyTaskRow {
  task: typeof applicationTasks.$inferSelect;
  job: Job;
}

/** Discord CDN hosts — a job recorded from a screenshot attachment. */
function isDiscordAttachmentUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === 'cdn.discordapp.com' || host === 'media.discordapp.net';
  } catch {
    return false;
  }
}

/** `N field(s)` for a discovered form. */
function fieldCount(spec: JobSpec): string {
  const count = spec.questions.length;
  return `${count} field${count === 1 ? '' : 's'}`;
}

/**
 * One reply line for a task, derived purely from its current DB state.
 * Wording mirrors replyFor's lines so an edit reads as an update, not a
 * rewrite; the dashboard task link is identical (taskLink), but the label
 * upgrades to `Title · Company` as soon as either is known.
 */
export function renderTaskLine(
  row: ReplyTaskRow,
  run: LatestRun | undefined,
  dashboardBaseUrl?: string,
): string {
  const { task, job } = row;
  const spec = task.jobSpec;
  // Parsed values first (processTask backfills jobs.title/company from the
  // discovered spec), then whatever the form-discovery spec carries, else the
  // shortened job URL. Never the task id.
  const ref = taskLink(
    task.id,
    taskLabel({
      title: job.title || spec?.title,
      company: job.company || spec?.company,
      url: job.url,
    }),
    dashboardBaseUrl,
  );
  const date = job.createdAt ? ` · ${formatEasternDate(job.createdAt)}` : '';

  // Discarded wins over everything: a human removed the task from the queue,
  // so no lifecycle line (queued/investigating/…) applies anymore.
  if (task.state === 'DISCARDED') {
    return `🗑️ ${ref} · discarded${date}`;
  }

  // Screenshot tasks: the run kind is authoritative; the CDN host covers
  // parked screenshots that never got an investigation run.
  if (run?.kind === 'screenshot' || (!run && isDiscordAttachmentUrl(job.url))) {
    if (run?.status === 'running') {
      return `🖼️ ${ref} · screenshot recorded · investigating…${date}`;
    }
    if (run?.status === 'found') {
      return `🖼️ ${ref} · screenshot recorded · job found${date}`;
    }
    if (run?.status === 'not_found') {
      return `🖼️ ${ref} · screenshot recorded · no job found${date}`;
    }
    return `🖼️ ${ref} · screenshot recorded${date}`;
  }

  // Supported/queued: same classification the poll ingested it under.
  // jobs.platform is free text in the DB; a non-Platform string simply has
  // no adapter (getAdapter returns null) and falls through to unsupported.
  if (
    getAdapter(job.platform as Platform) &&
    job.tenant !== null &&
    isIngestableJobUrl(job.platform, job.url)
  ) {
    return `✅ ${ref} · queued · ${job.platform}${date}`;
  }

  // Unsupported (recorded + parked): reflect the form-discovery lifecycle.
  if (run?.kind === 'form' && run.status === 'running') {
    return `🔎 ${ref} · discovering form…${date}`;
  }
  if (spec?.discoveredByAgent) {
    return spec.formVerified
      ? `✅ ${ref} · form verified: ${fieldCount(spec)}${date}`
      : `🔎 ${ref} · form discovered: ${fieldCount(spec)}${date}`;
  }
  if (run?.kind === 'form' && run.status === 'not_found') {
    return `⚠️ ${ref} · recorded (unsupported) · no form found${date}`;
  }
  return `⚠️ ${ref} · recorded (unsupported)${date}`;
}

/**
 * Re-render the #ingest reply that announced `taskId` and edit the Discord
 * message in place. No-op when the task carries no reply ref (it did not
 * arrive via #ingest, or storing the ref failed). Never throws.
 */
export async function refreshIngestReply(
  deps: Deps,
  taskId: string,
): Promise<void> {
  const { db, notify, config } = deps;
  if (!notify) {
    return;
  }
  try {
    const refRows = await db
      .select({
        ingestChannelId: applicationTasks.ingestChannelId,
        ingestMessageId: applicationTasks.ingestMessageId,
      })
      .from(applicationTasks)
      .where(eq(applicationTasks.id, taskId))
      .limit(1);
    const ref = refRows[0];
    if (!ref?.ingestChannelId || !ref.ingestMessageId) {
      return;
    }

    // Every task the same reply announced (siblings from one Discord
    // message), oldest-first so lines keep the original posting order.
    const rows: ReplyTaskRow[] = await db
      .select({ task: applicationTasks, job: jobs })
      .from(applicationTasks)
      .innerJoin(jobs, eq(applicationTasks.jobId, jobs.id))
      .where(eq(applicationTasks.ingestMessageId, ref.ingestMessageId))
      .orderBy(asc(applicationTasks.createdAt));
    if (rows.length === 0) {
      return;
    }

    // Latest investigation run per task (newest-first, first one wins).
    const runRows = await db
      .select({
        taskId: investigationRuns.taskId,
        kind: investigationRuns.kind,
        status: investigationRuns.status,
      })
      .from(investigationRuns)
      .where(
        inArray(
          investigationRuns.taskId,
          rows.map((row) => row.task.id),
        ),
      )
      .orderBy(desc(investigationRuns.startedAt));
    const latestRuns = new Map<string, LatestRun>();
    for (const run of runRows) {
      if (!latestRuns.has(run.taskId)) {
        latestRuns.set(run.taskId, { kind: run.kind, status: run.status });
      }
    }

    const text = renderReplyLines(
      rows.map((row) =>
        renderTaskLine(
          row,
          latestRuns.get(row.task.id),
          config.DASHBOARD_BASE_URL,
        ),
      ),
    );
    await notify.editChannelMessage(
      ref.ingestChannelId,
      ref.ingestMessageId,
      text,
    );
  } catch (error) {
    console.warn(
      `[sower] discord ingest: reply refresh failed for task ${taskId}:`,
      error,
    );
  }
}
