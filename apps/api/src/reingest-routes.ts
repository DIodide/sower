import type { PlatformRef } from '@sower/core';
import { canonicalizeUrl } from '@sower/core';
import { applicationTasks, type Job, jobs } from '@sower/db';
import { deriveGreenhouseTenant, detectPlatform } from '@sower/platforms';
import { computeDedupeKey } from '@sower/sources';
import { and, eq, ne, or } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { syncTaskCalendarEvent } from './calendar-sync.js';
import { parkReason, runIngestTail } from './ingest.js';
import { refreshIngestReply } from './ingest-reply.js';
import { triggerInvestigation } from './investigate-trigger.js';
import { trailingNumericJobId } from './link-extract.js';
import { transitionTask } from './transitions.js';
import type { Deps } from './types.js';

const taskParamsSchema = z.object({
  id: z.string().uuid(),
});

/**
 * Re-detect the platform identity from the job row's CURRENT url and, when
 * that yields a DISCOVERABLE identity for a row whose stored one is not
 * (unknown platform, tenant-less greenhouse, no adapter), adopt it onto the
 * row BEFORE the fresh task spawns. Two probes mirror the existing
 * self-heals: the VERIFIED greenhouse tenant probe ingestJob runs for
 * tenant-less gh_jid URLs, and the trailing-numeric-id probe processTask runs
 * for unknown-platform URLs (databricks-style custom-domain postings).
 *
 * Adoption mirrors process.ts adoptGreenhouseTenant's collision rule: the
 * identity columns always land, but canonical_url + dedupe_key are UNIQUE —
 * when ANOTHER job already owns the adopted identity, only the identity
 * columns are set and this row keeps its own URL (discovery reads tenant+id,
 * not the URL). The in-memory `job` is mutated to match, so the spawn that
 * follows sees the upgraded row.
 */
async function upgradeJobIdentity(deps: Deps, job: Job): Promise<void> {
  // jobs.platform is free text in the DB; PlatformRef.platform is the union.
  const storedRef: PlatformRef = {
    platform: job.platform as PlatformRef['platform'],
    tenant: job.tenant,
    externalId: job.externalId,
  };
  if (parkReason(storedRef) === null) {
    // Already discoverable — the stored identity is the best it gets.
    return;
  }

  let ref = detectPlatform(canonicalizeUrl(job.url));
  // The canonical board URL to adopt alongside a probe-verified identity;
  // null while no probe has upgraded the ref.
  let adoptUrl: string | null = null;

  if (
    ref.platform === 'greenhouse' &&
    ref.tenant === null &&
    ref.externalId !== null
  ) {
    // gh_jid on the company's own domain: the same VERIFIED tenant probe
    // ingestJob runs — a hit names the fixed board URL, a null changes
    // nothing (the fresh task parks exactly as the old one did).
    const tenant = await deriveGreenhouseTenant(job.url, ref.externalId);
    if (tenant !== null) {
      ref = { platform: 'greenhouse', tenant, externalId: ref.externalId };
      adoptUrl = `https://job-boards.greenhouse.io/${tenant}/jobs/${ref.externalId}`;
    }
  } else if (ref.platform === 'unknown') {
    // Custom-domain posting with only a trailing numeric id marker: the same
    // candidate-id probe processTask's self-heal uses.
    const candidateId = trailingNumericJobId(job.url);
    if (candidateId !== null) {
      const tenant = await deriveGreenhouseTenant(job.url, candidateId);
      if (tenant !== null) {
        ref = { platform: 'greenhouse', tenant, externalId: candidateId };
        adoptUrl = `https://job-boards.greenhouse.io/${tenant}/jobs/${candidateId}`;
      }
    }
  }

  if (parkReason(ref) !== null) {
    // No BETTER identity found — never downgrade the stored row.
    return;
  }

  const url = adoptUrl ?? job.url;
  const canonical = canonicalizeUrl(url);
  const dedupeKey = computeDedupeKey(ref, canonical);
  const identity = {
    platform: ref.platform,
    tenant: ref.tenant,
    externalId: ref.externalId,
  };
  const collisions = await deps.db
    .select({ id: jobs.id })
    .from(jobs)
    .where(
      and(
        ne(jobs.id, job.id),
        or(eq(jobs.canonicalUrl, canonical), eq(jobs.dedupeKey, dedupeKey)),
      ),
    )
    .limit(1);
  if (collisions.length > 0) {
    await deps.db.update(jobs).set(identity).where(eq(jobs.id, job.id));
    Object.assign(job, identity);
    return;
  }
  await deps.db
    .update(jobs)
    .set({ ...identity, url, canonicalUrl: canonical, dedupeKey })
    .where(eq(jobs.id, job.id));
  Object.assign(job, identity, { url, canonicalUrl: canonical });
}

/**
 * POST /tasks/:id/reingest — reset a task IN PLACE and run it through
 * ingestion again, as if the posting had just arrived: the SAME task row
 * (same id — nothing is discarded, no replacement spawns) transitions
 * REINGEST -> INGESTED with its pipeline artifacts cleared (attempt,
 * lastError, jobSpec, resolution — a fresh run rebuilds them; user
 * annotations like notes/priority/dueDate/sortRank survive), then walks
 * exactly the ingest-time tail (PARSE_OK, then queue or park+investigate).
 * Refused (409) only for SUBMITTED/CONFIRMED — an application already sent
 * cannot be silently redone; un-mark it first. DISCARDED/DUPLICATE tasks may
 * be re-ingested straight from the archive (no restore-first dance).
 *
 * x-api-key gated by the server-wide preHandler, like every other route.
 */
export function registerReingestRoutes(app: FastifyInstance, deps: Deps): void {
  app.post('/tasks/:id/reingest', async (request, reply) => {
    const parsed = taskParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: 'invalid task id', issues: parsed.error.issues });
    }
    const taskId = parsed.data.id;
    const rows = await deps.db
      .select({ task: applicationTasks, job: jobs })
      .from(applicationTasks)
      .innerJoin(jobs, eq(applicationTasks.jobId, jobs.id))
      .where(eq(applicationTasks.id, taskId))
      .limit(1);
    const row = rows[0];
    if (!row) {
      return reply.code(404).send({ error: 'task not found' });
    }
    const state = row.task.state;
    if (state === 'SUBMITTED' || state === 'CONFIRMED') {
      return reply.code(409).send({
        error: `cannot re-ingest a task in state '${state}' — mark it un-applied first`,
      });
    }

    // Identity first: re-detect/probe-upgrade from the job row's CURRENT url,
    // so the tail below sees the best identity available today.
    const job = row.job;
    await upgradeJobIdentity(deps, job);

    // In-place reset on the SAME task row, atomically: REINGEST -> INGESTED
    // with the pipeline artifacts cleared in the same UPDATE. User
    // annotations (notes, priority, dueDate, sortRank, ingest reply refs)
    // are deliberately untouched.
    const ingested = await transitionTask(
      deps.db,
      taskId,
      state,
      'REINGEST',
      { reason: 'manual' },
      { attempt: 0, lastError: null, jobSpec: null, resolution: null },
    );

    // The same ingest-time tail a fresh task walks — against THIS task.
    const tail = await runIngestTail(deps, job, taskId, ingested);
    if (tail.parkedReason !== null) {
      // Parked: nothing can process it — offer Tier-2 form discovery exactly
      // like a fresh unsupported ingest (self-gating, never throws).
      await triggerInvestigation(deps, taskId);
    }

    // Best-effort: the #ingest reply line returns to queued/parked, and the
    // reset task's calendar event follows its new state (a re-ingest out of
    // the archive restores the event its deadline warrants; both never throw).
    await refreshIngestReply(deps, taskId);
    await syncTaskCalendarEvent(deps, taskId);

    return reply.code(200).send({ ok: true, state: tail.state });
  });
}
