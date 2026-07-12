import type { PlatformRef, TaskState } from '@sower/core';
import { canonicalizeUrl } from '@sower/core';
import { applicationTasks, jobs } from '@sower/db';
import { detectPlatform, getAdapter, resolveUrl } from '@sower/platforms';
import { eq } from 'drizzle-orm';
import { transitionTask } from './transitions.js';
import type { Deps } from './types.js';

export interface IngestInput {
  url: string;
  source?: string;
  company?: string;
  title?: string;
  terms?: string[];
}

export type IngestResult =
  | { duplicate: true; jobId: string }
  | { duplicate: false; jobId: string; taskId: string; state: TaskState };

/**
 * Returns the reason a parsed job must be parked (NEEDS_INPUT, no enqueue)
 * instead of queued, or null when an adapter can actually discover it.
 */
function parkReason(ref: PlatformRef): string | null {
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
 * Shared ingest pipeline used by POST /ingest and POST /sources/simplify/poll:
 * resolve -> canonicalize -> detect platform -> dedupe -> insert job + task ->
 * PARSE_OK -> PARSED, then either PARK -> NEEDS_INPUT (nothing can process it,
 * no enqueue) or ENQUEUE -> QUEUED + queue.enqueueProcess.
 */
export async function ingestJob(
  deps: Deps,
  input: IngestInput,
): Promise<IngestResult> {
  const { db, queue } = deps;

  const resolvedUrl = await resolveUrl(input.url);
  const canonicalUrl = canonicalizeUrl(resolvedUrl);
  const ref = detectPlatform(canonicalUrl);

  const existing = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(eq(jobs.canonicalUrl, canonicalUrl))
    .limit(1);
  const duplicateRow = existing[0];
  if (duplicateRow) {
    return { duplicate: true, jobId: duplicateRow.id };
  }

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
    })
    .returning({ id: jobs.id });
  const job = insertedJobs[0];
  if (!job) {
    throw new Error('failed to insert job');
  }

  const insertedTasks = await db
    .insert(applicationTasks)
    .values({ jobId: job.id, state: 'INGESTED' })
    .returning({ id: applicationTasks.id });
  const task = insertedTasks[0];
  if (!task) {
    throw new Error('failed to insert application task');
  }

  let state = await transitionTask(db, task.id, 'INGESTED', 'PARSE_OK', {
    canonicalUrl,
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
    return { duplicate: false, jobId: job.id, taskId: task.id, state };
  }

  state = await transitionTask(db, task.id, state, 'ENQUEUE');
  await queue.enqueueProcess(task.id);
  return { duplicate: false, jobId: job.id, taskId: task.id, state };
}
