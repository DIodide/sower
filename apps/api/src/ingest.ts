import type { PlatformRef, TaskState } from '@sower/core';
import { canonicalizeUrl, stripTrackingParams } from '@sower/core';
import { applicationTasks, jobs } from '@sower/db';
import {
  deriveGreenhouseTenant,
  detectPlatform,
  getAdapter,
  resolveUrl,
} from '@sower/platforms';
import { computeDedupeKey } from '@sower/sources';
import { asc, eq } from 'drizzle-orm';
import { isIngestableJobUrl } from './link-extract.js';
import { transitionTask } from './transitions.js';
import type { Deps } from './types.js';

export interface IngestInput {
  url: string;
  source?: string;
  company?: string;
  title?: string;
  terms?: string[];
  /**
   * Resolve the URL with a live GET before canonicalizing (default true).
   * Pass false when the URL must be recorded as-is — e.g. a Discord screenshot
   * attachment, where the CDN link is an image we've already downloaded, not a
   * page worth re-fetching. Dedupe + park logic is unchanged either way.
   */
  resolve?: boolean;
}

export type IngestResult =
  | {
      duplicate: true;
      jobId: string;
      /** Earliest task on the existing job; null if the job somehow has none. */
      taskId: string | null;
      /** Provenance of the EXISTING job (its `source` column). */
      originalSource: string;
      /** When the existing job was first ingested. */
      originalCreatedAt: Date;
    }
  | { duplicate: false; jobId: string; taskId: string; state: TaskState };

/**
 * Build the enriched duplicate result: the existing job's provenance
 * (source + createdAt) plus its earliest task id, so callers (e.g. the
 * Discord ingest reply) can link the original instead of a bare "duplicate".
 */
async function duplicateResult(
  db: Deps['db'],
  existing: { id: string; source: string; createdAt: Date | null },
): Promise<IngestResult> {
  const tasks = await db
    .select({ id: applicationTasks.id })
    .from(applicationTasks)
    .where(eq(applicationTasks.jobId, existing.id))
    .orderBy(asc(applicationTasks.createdAt))
    .limit(1);
  return {
    duplicate: true,
    jobId: existing.id,
    taskId: tasks[0]?.id ?? null,
    originalSource: existing.source,
    originalCreatedAt: existing.createdAt ?? new Date(0),
  };
}

/**
 * Returns the reason a parsed job must be parked (NEEDS_INPUT, no enqueue)
 * instead of queued, or null when an adapter can actually discover it.
 * Exported for the reingest route, which parks/queues by the same rule.
 */
export function parkReason(ref: PlatformRef): string | null {
  if (ref.platform === 'unknown') {
    return 'unknown platform';
  }
  if (ref.platform === 'greenhouse' && ref.tenant === null) {
    // gh_jid on a custom careers domain: we know it is greenhouse but cannot
    // reach the board API without the tenant.
    return 'greenhouse job without tenant (custom domain)';
  }
  if (getAdapter(ref.platform) === null) {
    return `no adapter registered for platform '${ref.platform}'`;
  }
  return null;
}

/**
 * True when an adapter can discover this ref straight from the URL's
 * tenant+id via the platform API — i.e. no live GET is needed to ingest it.
 */
function isDiscoverableRef(ref: PlatformRef, url: string): boolean {
  return parkReason(ref) === null && isIngestableJobUrl(ref.platform, url);
}

/**
 * Shared ingest pipeline used by POST /ingest and POST /sources/simplify/poll:
 * detect platform (resolving the URL first ONLY when the input is not already
 * a supported posting) -> canonicalize -> dedupe -> insert job + task ->
 * PARSE_OK -> PARSED, then either PARK -> NEEDS_INPUT (nothing can process it,
 * no enqueue) or ENQUEUE -> QUEUED + queue.enqueueProcess.
 */
export async function ingestJob(
  deps: Deps,
  input: IngestInput,
): Promise<IngestResult> {
  const { db } = deps;

  // Detect on the INPUT url before any live GET: a supported ATS URL is
  // discovered via the platform API from the tenant+id in the URL itself, so
  // resolving adds nothing — and can LOSE the platform identity entirely when
  // the board redirects to the company's own domain (custom-domain greenhouse
  // tenants: job-boards.greenhouse.io/stripe/… → stripe.com/jobs/…). Unknown
  // URLs (shorteners, custom domains) still resolve exactly as before.
  let resolvedUrl = input.url;
  if (
    input.resolve !== false &&
    !isDiscoverableRef(detectPlatform(canonicalizeUrl(input.url)), input.url)
  ) {
    resolvedUrl = await resolveUrl(input.url);
  }
  // The STORED url must not carry tracking/referral params (a pasted board
  // link tagged gh_src=zero2sudo would otherwise spread that referral every
  // time the posting link is opened). Dedupe already ignores them via
  // canonicalizeUrl; this cleans what we persist and re-open.
  resolvedUrl = stripTrackingParams(resolvedUrl);
  let canonicalUrl = canonicalizeUrl(resolvedUrl);
  let ref = detectPlatform(canonicalUrl);
  // VERIFIED tenant probe: a gh_jid URL on a company's own domain names the
  // greenhouse job but not the board tenant, which would park it below. Try
  // hostname-derived candidates against the FIXED boards API first; a
  // verified hit rewrites the ingest to the canonical board URL (stored url
  // included, like the discord greenhouse-sniff path) so it dedupes with
  // board-hosted pastes and enqueues as a normal supported greenhouse job.
  // A null probe changes nothing — the task parks exactly as before.
  if (
    ref.platform === 'greenhouse' &&
    ref.tenant === null &&
    ref.externalId !== null
  ) {
    const tenant = await deriveGreenhouseTenant(resolvedUrl, ref.externalId);
    if (tenant !== null) {
      resolvedUrl = `https://job-boards.greenhouse.io/${tenant}/jobs/${ref.externalId}`;
      canonicalUrl = canonicalizeUrl(resolvedUrl);
      ref = detectPlatform(canonicalUrl);
    }
  }
  const dedupeKey = computeDedupeKey(ref, canonicalUrl);

  // Fast path: exact same canonical URL already ingested. Also covers legacy
  // rows whose dedupe_key is still NULL (pre-backfill), which the ON CONFLICT
  // arbiter below cannot see.
  const existing = await db
    .select({ id: jobs.id, source: jobs.source, createdAt: jobs.createdAt })
    .from(jobs)
    .where(eq(jobs.canonicalUrl, canonicalUrl))
    .limit(1);
  const duplicateRow = existing[0];
  if (duplicateRow) {
    return duplicateResult(db, duplicateRow);
  }

  // Same posting reached via a different URL (e.g. boards.greenhouse.io vs
  // job-boards.greenhouse.io) collides on dedupe_key: DO NOTHING and report
  // the existing job as a duplicate. The unique constraint arbitrates races.
  const insertedJobs = await db
    .insert(jobs)
    .values({
      url: resolvedUrl,
      canonicalUrl,
      company: input.company ?? null,
      title: input.title ?? null,
      platform: ref.platform,
      tenant: ref.tenant,
      externalId: ref.externalId,
      terms: input.terms ?? null,
      source: input.source ?? 'manual',
      dedupeKey,
    })
    .onConflictDoNothing({ target: jobs.dedupeKey })
    .returning({ id: jobs.id });
  const job = insertedJobs[0];
  if (!job) {
    const conflicted = await db
      .select({ id: jobs.id, source: jobs.source, createdAt: jobs.createdAt })
      .from(jobs)
      .where(eq(jobs.dedupeKey, dedupeKey))
      .limit(1);
    const conflictedRow = conflicted[0];
    if (conflictedRow) {
      return duplicateResult(db, conflictedRow);
    }
    throw new Error('failed to insert job');
  }

  const spawned = await spawnTaskForJob(deps, {
    id: job.id,
    canonicalUrl,
    platform: ref.platform,
    tenant: ref.tenant,
    externalId: ref.externalId,
  });
  return {
    duplicate: false,
    jobId: job.id,
    taskId: spawned.taskId,
    state: spawned.state,
  };
}

/** What spawnTaskForJob produced: the fresh task, where it landed, and — when
 *  it parked — the parkReason, so callers can react (e.g. trigger Tier-2 form
 *  discovery). */
export interface SpawnedTask {
  taskId: string;
  state: TaskState;
  /** Why the task parked NEEDS_INPUT; null when it was queued. */
  parkedReason: string | null;
}

/**
 * The ingest-time task tail, shared by ingestJob and POST /tasks/:id/reingest:
 * insert a fresh application_tasks row on `job` (INGESTED), record PARSE_OK,
 * then either PARK -> NEEDS_INPUT (nothing can discover the job's platform
 * identity, no enqueue) or ENQUEUE -> QUEUED + queue.enqueueProcess. The
 * platform identity is read from the fields passed in, so callers must pass
 * the CURRENT job-row values (reingest re-detects/upgrades them first).
 */
export async function spawnTaskForJob(
  deps: Deps,
  job: {
    id: string;
    canonicalUrl: string;
    platform: string;
    tenant: string | null;
    externalId: string | null;
  },
): Promise<SpawnedTask> {
  const { db, queue } = deps;
  // jobs.platform is free text in the DB; PlatformRef.platform is the union.
  const ref: PlatformRef = {
    platform: job.platform as PlatformRef['platform'],
    tenant: job.tenant,
    externalId: job.externalId,
  };

  const insertedTasks = await db
    .insert(applicationTasks)
    .values({ jobId: job.id, state: 'INGESTED' })
    .returning({ id: applicationTasks.id });
  const task = insertedTasks[0];
  if (!task) {
    throw new Error('failed to insert application task');
  }

  let state = await transitionTask(db, task.id, 'INGESTED', 'PARSE_OK', {
    canonicalUrl: job.canonicalUrl,
    platform: ref.platform,
  });

  const reason = parkReason(ref);
  if (reason !== null) {
    // Park for manual input. Do NOT enqueue: no adapter can discover it.
    state = await transitionTask(db, task.id, state, 'PARK', {
      reason,
      platform: ref.platform,
      tenant: ref.tenant,
    });
    return { taskId: task.id, state, parkedReason: reason };
  }

  state = await transitionTask(db, task.id, state, 'ENQUEUE');
  await queue.enqueueProcess(task.id);
  return { taskId: task.id, state, parkedReason: null };
}
