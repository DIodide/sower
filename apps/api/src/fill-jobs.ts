import type { BankEntry, BankValue } from '@sower/answers';
import type {
  JobSpec,
  Platform,
  Question,
  ResolutionResult,
  TaskState,
} from '@sower/core';
import {
  answers,
  applicationTasks,
  documents,
  events,
  type FillJob,
  fillJobs,
  jobs,
} from '@sower/db';
import { getAdapter } from '@sower/platforms';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { z } from 'zod';
import { computeResolution } from './process.js';
import {
  buildQuestions,
  type DocumentInfo,
  type SavedContext,
  taskIdentity,
} from './task-views.js';
import type { Deps } from './types.js';

/**
 * "Fill in browser" bridge (greenhouse v1): the dashboard requests a fill
 * (POST /tasks/:id/fill); the runner daemon on the user's machine claims it,
 * types every answered question into the REAL greenhouse form over CDP, and
 * reports back a live-view URL + per-field outcomes. The runner NEVER
 * submits — the human finishes in the live view. All routes x-api-key via
 * the server-wide preHandler; per-question statuses reuse task-views
 * buildQuestions so the payload matches exactly what the dashboard shows.
 */

/** claimed/running rows silent longer than this are reaped to 'failed'. */
const HEARTBEAT_STALE_MS = 5 * 60_000;

/** Task states a browser fill may be requested from. */
const FILLABLE_STATES: readonly TaskState[] = ['NEEDS_INPUT', 'REVIEW'];

/** Statuses that can still become 'ready' — at most one per task. */
const ACTIVE_STATUSES = ['requested', 'claimed', 'running'] as const;

const idParamsSchema = z.object({
  id: z.string().uuid(),
});

// The runner's live-view link (a human devtools URL). http(s)/wss only, so
// a javascript: value can never land in the dashboard's <a href>.
const liveViewUrlSchema = z
  .string()
  .max(2000)
  .regex(/^(https?|wss):\/\//, 'must be an http(s)/wss URL');

const reportEntrySchema = z.object({
  questionId: z.string().min(1),
  // The claim payload can legitimately carry an empty label; the runner
  // echoes it back, and a successful fill must never 400 its own report.
  label: z.string(),
  outcome: z.enum(['filled', 'skipped', 'failed']),
  // 600 = the runner's summarizeFailure budget, which keeps both ends of
  // a Playwright call log so the reason survives the trim.
  detail: z.string().max(600).optional(),
});

const reportBodySchema = z.object({
  status: z.enum(['running', 'ready']),
  liveViewUrl: liveViewUrlSchema.optional(),
  report: z.array(reportEntrySchema).optional(),
});

const failBodySchema = z.object({
  error: z.string().min(1).max(2000),
});

/**
 * Whether a requested/claimed/running job still blocks a new request: a
 * 'requested' row always does (the runner just hasn't polled yet); a
 * claimed/running row only while its heartbeat (or claim) is fresh — a
 * stale one is a dead runner's leftover, reaped by the claim endpoint.
 */
function isActive(job: FillJob, now: Date): boolean {
  if (job.status === 'requested') {
    return true;
  }
  const lastSeen = job.heartbeatAt ?? job.claimedAt;
  return (
    lastSeen !== null && now.getTime() - lastSeen.getTime() < HEARTBEAT_STALE_MS
  );
}

/** One question of the runner's payload — RAW input values, never display text. */
export interface FillQuestion {
  id: string;
  label: string;
  type: Question['type'];
  required: boolean;
  options: { label: string; value: string }[];
  values: string[] | null;
  /** Synthesized from a form-level signal: absent on a posting = skip. */
  formOnly?: boolean;
  /**
   * File questions: the stored document to put in the form's file input,
   * fetched by the runner from GET /documents/:id/content. Absent when no
   * document is attached — the human attaches one in the live view.
   */
  document?: { id: string; filename: string };
}

/**
 * The runner's per-question fill payload. Statuses come from the SAME
 * derivation every client surface uses (task-views buildQuestions, the
 * answers-bank 'saved' fallback included); this only maps each status to
 * the RAW values to enter: a resolved answer's stored input value(s), else
 * the banked savedInput, else null (unanswered — the runner skips it).
 * File questions are always values:null — v1 reports them for manual
 * attach in the live view.
 */
export function buildFillQuestions(
  spec: JobSpec | null,
  resolution: ResolutionResult | null,
  savedContext: SavedContext,
): FillQuestion[] {
  if (!spec) {
    return [];
  }
  const rawById = new Map(
    (resolution?.resolved ?? []).map((answer) => [
      answer.questionId,
      answer.value,
    ]),
  );
  const filenameByPath = new Map(
    [...savedContext.docByPath].map(([path, doc]) => [path, doc.filename]),
  );
  // buildQuestions returns one summary per spec question, in spec order.
  const summaries = buildQuestions(
    spec,
    resolution,
    filenameByPath,
    savedContext,
  );
  const docById = new Map(
    [...savedContext.docByPath.values()].map((doc) => [doc.id, doc]),
  );
  return spec.questions.map((question, i) => {
    const summary = summaries[i];
    let values: string[] | null = null;
    // A file question's answer is a document, not a value: the resolution
    // holds its storagePath, a bank pick its document id.
    let document: { id: string; filename: string } | undefined;
    if (question.type === 'file' && summary !== undefined) {
      const raw = rawById.get(question.id);
      const doc =
        summary.status === 'resolved' && typeof raw === 'string'
          ? savedContext.docByPath.get(raw)
          : summary.status === 'saved' && summary.savedDocId !== undefined
            ? docById.get(summary.savedDocId)
            : undefined;
      if (doc) {
        document = { id: doc.id, filename: doc.filename };
      }
    }
    if (question.type !== 'file' && summary !== undefined) {
      if (summary.status === 'resolved') {
        const raw = rawById.get(question.id);
        const list =
          raw === null || raw === undefined
            ? []
            : Array.isArray(raw)
              ? raw
              : [raw];
        values = list.length > 0 ? list.map(String) : null;
      } else if (summary.status === 'saved') {
        // savedInput holds only options that exist on THIS form; empty
        // means nothing fillable, so the question stays unanswered.
        const input = summary.savedInput ?? [];
        values = input.length > 0 ? input : null;
      }
    }
    const fill: FillQuestion = {
      id: question.id,
      label: question.label,
      type: question.type,
      required: question.required,
      options: (question.options ?? []).map((option) => ({
        label: option.label,
        value: String(option.value),
      })),
      values,
    };
    if (question.formOnly === true) {
      fill.formOnly = true;
    }
    if (document !== undefined) {
      fill.document = document;
    }
    return fill;
  });
}

/**
 * Where the browser fill should open. A posting that greenhouse hosts is
 * filled where it lives. An EMBEDDED posting — one whose apply URL is the
 * company's own site — is not: that page either wraps the greenhouse form
 * in a cross-origin iframe (Jump Trading) or renders a form of its own
 * against greenhouse's API (Stripe), and neither is the DOM the filler
 * knows. The form those pages embed is a page of its own at greenhouse's
 * embed endpoint, addressed by board tenant + job id, and it is the same
 * form the hosted board renders: same field ids, same submission.
 *
 * Falls back to the apply URL when the spec cannot name the board.
 */
export function fillTargetUrl(spec: JobSpec | null, applyUrl: string): string {
  // Only greenhouse has an embed page to redirect to; every other platform
  // fills the apply url as it is.
  if (spec !== null && spec.platform !== 'greenhouse') {
    return applyUrl;
  }
  let host = '';
  try {
    host = new URL(applyUrl).hostname;
  } catch {
    return applyUrl;
  }
  if (host === 'greenhouse.io' || host.endsWith('.greenhouse.io')) {
    return applyUrl;
  }
  const tenant = spec?.tenant;
  const externalId = spec?.externalId;
  if (!tenant || !externalId) {
    return applyUrl;
  }
  const params = new URLSearchParams({ for: tenant, token: externalId });
  return `https://job-boards.greenhouse.io/embed/job_app?${params.toString()}`;
}

/**
 * The claimed job's payload: identity + applyUrl via the task-views
 * fallbacks, questions via buildFillQuestions. Reads the whole (small,
 * personal) documents + answers tables — the /cli detail's same reads — so
 * the 'saved' bank fallback matches exactly what the dashboard shows.
 */
async function buildClaimPayload(deps: Deps, taskId: string) {
  const rows = await deps.db
    .select({ task: applicationTasks, job: jobs })
    .from(applicationTasks)
    .innerJoin(jobs, eq(applicationTasks.jobId, jobs.id))
    .where(eq(applicationTasks.id, taskId))
    .limit(1);
  const row = rows[0];
  if (!row) {
    // FK-unreachable (a fill job references its task); surface, never guess.
    throw new Error(`fill job task ${taskId} not found`);
  }
  const documentRows = await deps.db
    .select({
      id: documents.id,
      kind: documents.kind,
      filename: documents.filename,
      storagePath: documents.storagePath,
    })
    .from(documents)
    .orderBy(desc(documents.createdAt));
  const bankRows = await deps.db
    .select({
      normalizedLabel: answers.normalizedLabel,
      value: answers.value,
      company: answers.company,
    })
    .from(answers);
  const spec = row.task.jobSpec ?? null;
  const identity = taskIdentity({
    company: row.job.company,
    title: row.job.title,
    jobSpec: spec,
    url: row.job.url,
  });
  // Raw company for bank scoping (selectBankValue normalizes defensively).
  const company = row.job.company || spec?.company || null;
  const docByPath = new Map<string, DocumentInfo>(
    documentRows.map((doc) => [
      doc.storagePath,
      { id: doc.id, kind: doc.kind, filename: doc.filename },
    ]),
  );
  const bank: BankEntry[] = bankRows.map((entry) => ({
    normalizedLabel: entry.normalizedLabel,
    value: entry.value as BankValue,
    company: entry.company,
  }));
  return {
    platform: row.job.platform,
    applyUrl: spec?.applyUrl ?? row.job.url,
    fillUrl: fillTargetUrl(spec, spec?.applyUrl ?? row.job.url),
    company: identity.company,
    title: identity.title,
    questions: buildFillQuestions(spec, row.task.resolution ?? null, {
      bank,
      company: company ?? undefined,
      docByPath,
    }),
  };
}

/**
 * Questions the board asks today that the stored spec does not know about:
 * the ones the adapter has since learned to synthesize (country, the
 * education block, the Hispanic/Latino gate) and any the employer added
 * after the task was discovered. Existing questions are never touched —
 * the investigator may have enriched them — so this only ever grows the
 * spec. Pure, so the merge rule is testable without an adapter.
 */
export function mergeDiscoveredQuestions(
  stored: JobSpec,
  fresh: JobSpec,
): JobSpec | null {
  const known = new Set(stored.questions.map((question) => question.id));
  const added = fresh.questions.filter((question) => !known.has(question.id));
  if (added.length === 0) {
    return null;
  }
  return { ...stored, questions: [...stored.questions, ...added] };
}

/**
 * Re-discover the posting and fold in any question the stored spec lacks,
 * before a fill reads it. A task discovered before the adapter learned to
 * synthesize a question keeps filling without it forever otherwise — the
 * resolution refresh below can only answer questions the spec has.
 *
 * Failure is not a task failure: a posting that has gone quiet since
 * (which is exactly what requeueing such a task turns into FAILED) just
 * fills from the spec it has.
 */
async function refreshSpecQuestions(
  deps: Deps,
  log: FastifyBaseLogger,
  row: {
    task: typeof applicationTasks.$inferSelect;
    job: typeof jobs.$inferSelect;
  },
): Promise<void> {
  const spec = row.task.jobSpec;
  if (!spec || !spec.tenant || !spec.externalId) {
    return;
  }
  try {
    const adapter = getAdapter(row.job.platform as Platform);
    if (!adapter) {
      return;
    }
    const fresh = await adapter.discover(
      {
        platform: row.job.platform as Platform,
        tenant: spec.tenant,
        externalId: spec.externalId,
      },
      row.job.url,
    );
    const merged = mergeDiscoveredQuestions(spec, fresh);
    if (merged === null) {
      return;
    }
    await deps.db
      .update(applicationTasks)
      .set({ jobSpec: merged, updatedAt: new Date() })
      .where(eq(applicationTasks.id, row.task.id));
    row.task.jobSpec = merged;
    log.info(
      {
        taskId: row.task.id,
        added: merged.questions.length - spec.questions.length,
      },
      'fill: folded newly discovered questions into the spec',
    );
  } catch (error) {
    log.warn(
      { err: error, taskId: row.task.id },
      'fill: could not re-discover the posting — filling from the stored spec',
    );
  }
}

/**
 * Bring the task's stored resolution up to date with the answer bank before
 * a fill reads it.
 *
 * The stored resolution is a snapshot from the task's last pipeline run, and
 * the bank moves on without it: an answer saved since then — or one that now
 * supersedes a curated decline, which is how "Gender" kept typing "Decline
 * To Self Identify" for someone who had answered it — is invisible to a fill
 * that trusts the snapshot. Recomputing with the SAME resolver the pipeline
 * uses keeps the dashboard and the fill agreeing on what is about to be
 * typed, without re-running discovery (which can fail a task whose posting
 * has since gone).
 *
 * A recompute is never allowed to make the task worse. An unreadable profile
 * resolves as the EMPTY profile rather than throwing, so a degraded run would
 * quietly wipe good answers off the task; a snapshot that resolves fewer
 * questions than the stored one is discarded instead.
 */
async function refreshResolution(
  deps: Deps,
  log: FastifyBaseLogger,
  row: {
    task: typeof applicationTasks.$inferSelect;
    job: typeof jobs.$inferSelect;
  },
): Promise<void> {
  const spec = row.task.jobSpec;
  if (!spec) {
    return;
  }
  try {
    const fresh = await computeResolution(deps, row.job, spec);
    const stored = row.task.resolution;
    if (stored !== null && fresh.resolved.length < stored.resolved.length) {
      log.warn(
        {
          taskId: row.task.id,
          freshResolved: fresh.resolved.length,
          storedResolved: stored.resolved.length,
        },
        'fill: recomputed resolution answers fewer questions than the stored one — keeping the stored one',
      );
      return;
    }
    await deps.db
      .update(applicationTasks)
      .set({ resolution: fresh, updatedAt: new Date() })
      .where(eq(applicationTasks.id, row.task.id));
    row.task.resolution = fresh;
  } catch (error) {
    log.warn(
      { err: error, taskId: row.task.id },
      'fill: could not refresh the resolution — falling back to the stored one',
    );
  }
}

/** Platforms the runner has a form executor for. */
export const FILLABLE_PLATFORMS: ReadonlySet<string> = new Set([
  'greenhouse',
  'ashby',
]);

export function registerFillJobRoutes(app: FastifyInstance, deps: Deps): void {
  // Dashboard: request a browser fill for a greenhouse task the human is
  // working on (NEEDS_INPUT/REVIEW). One active job per task — a second
  // request while one is requested, or claimed/running with a fresh
  // heartbeat, is a 409 carrying that job; a stale claimed/running row
  // never blocks (the claim endpoint reaps it).
  app.post('/tasks/:id/fill', async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply
        .code(400)
        .send({ error: 'invalid task id', issues: params.error.issues });
    }
    const taskId = params.data.id;
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
    if (!FILLABLE_PLATFORMS.has(row.job.platform)) {
      return reply.code(409).send({
        error: `browser fill supports ${[...FILLABLE_PLATFORMS].join(', ')}; task platform is '${row.job.platform}'`,
      });
    }
    if (!FILLABLE_STATES.includes(row.task.state)) {
      return reply
        .code(409)
        .send({ error: `cannot fill a task in state '${row.task.state}'` });
    }
    await refreshSpecQuestions(deps, request.log, row);
    await refreshResolution(deps, request.log, row);
    const now = new Date();
    const openJobs = await deps.db
      .select()
      .from(fillJobs)
      .where(
        and(
          eq(fillJobs.taskId, taskId),
          inArray(fillJobs.status, [...ACTIVE_STATUSES]),
        ),
      )
      .orderBy(desc(fillJobs.requestedAt));
    const active = openJobs.find((job) => isActive(job, now));
    if (active) {
      return reply.code(409).send({
        error: 'a browser fill is already in progress for this task',
        job: active,
      });
    }
    const inserted = await deps.db
      .insert(fillJobs)
      .values({ taskId })
      .returning();
    const job = inserted[0];
    if (!job) {
      return reply.code(500).send({ error: 'failed to record fill job' });
    }
    // Timeline annotation (a direct events insert, not a transition — the
    // task's state is unchanged).
    await deps.db.insert(events).values({
      taskId,
      type: 'FILL_REQUESTED',
      data: { jobId: job.id },
    });
    return reply.code(200).send({ job });
  });

  // Runner: claim the oldest pending fill. Stale claimed/running rows are
  // reaped to 'failed' first (their runner died mid-fill), then the claim
  // races on the FOR UPDATE SKIP LOCKED idiom (sessions-actions.ts) so
  // concurrent runners never grab the same job.
  app.post('/fill-jobs/claim', async (_request, reply) => {
    const now = new Date();
    const cutoff = new Date(now.getTime() - HEARTBEAT_STALE_MS);
    const reaped = await deps.db
      .update(fillJobs)
      .set({
        status: 'failed',
        error: 'runner heartbeat lost',
        finishedAt: now,
      })
      .where(
        and(
          inArray(fillJobs.status, ['claimed', 'running']),
          // toISOString(): a raw-sql Date param has no column type context, so
          // drizzle would send Date.toString() ("Fri Aug 28 2026…"), which
          // Postgres rejects for timestamptz (500 on every claim — live bug).
          sql`coalesce(${fillJobs.heartbeatAt}, ${fillJobs.claimedAt}) < ${cutoff.toISOString()}`,
        ),
      )
      .returning({ id: fillJobs.id, taskId: fillJobs.taskId });
    for (const job of reaped) {
      await deps.db.insert(events).values({
        taskId: job.taskId,
        type: 'FILL_FAILED',
        data: { jobId: job.id, error: 'runner heartbeat lost' },
      });
    }

    const claimed = await deps.db
      .update(fillJobs)
      .set({ status: 'claimed', claimedAt: now, heartbeatAt: now })
      .where(
        sql`${fillJobs.id} = (
          select id from fill_jobs
          where status = 'requested'
          order by requested_at asc
          limit 1
          for update skip locked
        )`,
      )
      .returning();
    const job = claimed[0];
    if (!job) {
      return reply.code(200).send({ job: null });
    }
    const payload = await buildClaimPayload(deps, job.taskId);
    return reply
      .code(200)
      .send({ job: { id: job.id, taskId: job.taskId }, payload });
  });

  // Runner: report progress on a claimed job — 'running' once the tab is
  // open (with the live-view URL), 'ready' when every answered field was
  // attempted (with the per-field report). Only claimed/running jobs may
  // report; 'ready' finishes the job and annotates the task's timeline.
  app.post('/fill-jobs/:id/report', async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply
        .code(400)
        .send({ error: 'invalid fill job id', issues: params.error.issues });
    }
    const body = reportBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply
        .code(400)
        .send({ error: 'invalid body', issues: body.error.issues });
    }
    const jobId = params.data.id;
    const rows = await deps.db
      .select()
      .from(fillJobs)
      .where(eq(fillJobs.id, jobId))
      .limit(1);
    const row = rows[0];
    if (!row) {
      return reply.code(404).send({ error: 'fill job not found' });
    }
    if (row.status !== 'claimed' && row.status !== 'running') {
      return reply.code(409).send({
        error: `cannot report on a fill job in status '${row.status}'`,
      });
    }
    const set: {
      status: 'running' | 'ready';
      liveViewUrl?: string;
      report?: z.infer<typeof reportEntrySchema>[];
      finishedAt?: Date;
    } = { status: body.data.status };
    if (body.data.liveViewUrl !== undefined) {
      set.liveViewUrl = body.data.liveViewUrl;
    }
    if (body.data.report !== undefined) {
      set.report = body.data.report;
    }
    if (body.data.status === 'ready') {
      set.finishedAt = new Date();
    }
    const updated = await deps.db
      .update(fillJobs)
      .set(set)
      .where(eq(fillJobs.id, jobId))
      .returning();
    const job = updated[0];
    if (!job) {
      return reply.code(500).send({ error: 'failed to update fill job' });
    }
    if (body.data.status === 'ready') {
      await deps.db.insert(events).values({
        taskId: row.taskId,
        type: 'FILL_READY',
        data: {
          jobId: row.id,
          liveViewUrl: body.data.liveViewUrl ?? row.liveViewUrl ?? null,
        },
      });
    }
    return reply.code(200).send({ job });
  });

  // Runner: report a failed fill (any throw in the loop lands here; the
  // runner destroys the session only for failures before/during the
  // fill). Only claimed/running jobs may fail — matching the
  // report/heartbeat guards — so a finished or not-yet-claimed row can
  // never be clobbered by a late runner.
  app.post('/fill-jobs/:id/fail', async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply
        .code(400)
        .send({ error: 'invalid fill job id', issues: params.error.issues });
    }
    const body = failBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply
        .code(400)
        .send({ error: 'invalid body', issues: body.error.issues });
    }
    const jobId = params.data.id;
    const rows = await deps.db
      .select()
      .from(fillJobs)
      .where(eq(fillJobs.id, jobId))
      .limit(1);
    const row = rows[0];
    if (!row) {
      return reply.code(404).send({ error: 'fill job not found' });
    }
    if (row.status !== 'claimed' && row.status !== 'running') {
      return reply.code(409).send({
        error: `cannot fail a fill job in status '${row.status}'`,
      });
    }
    const updated = await deps.db
      .update(fillJobs)
      .set({
        status: 'failed',
        error: body.data.error,
        finishedAt: new Date(),
      })
      .where(eq(fillJobs.id, jobId))
      .returning();
    const job = updated[0];
    if (!job) {
      return reply.code(500).send({ error: 'failed to update fill job' });
    }
    await deps.db.insert(events).values({
      taskId: row.taskId,
      type: 'FILL_FAILED',
      data: { jobId: row.id, error: body.data.error },
    });
    return reply.code(200).send({ job });
  });

  // Runner liveness while working a job (every ~30s); the claim endpoint
  // reaps rows whose heartbeat goes stale.
  app.post('/fill-jobs/:id/heartbeat', async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply
        .code(400)
        .send({ error: 'invalid fill job id', issues: params.error.issues });
    }
    const jobId = params.data.id;
    const rows = await deps.db
      .select({ status: fillJobs.status })
      .from(fillJobs)
      .where(eq(fillJobs.id, jobId))
      .limit(1);
    const row = rows[0];
    if (!row) {
      return reply.code(404).send({ error: 'fill job not found' });
    }
    if (row.status !== 'claimed' && row.status !== 'running') {
      return reply.code(409).send({
        error: `cannot heartbeat a fill job in status '${row.status}'`,
      });
    }
    await deps.db
      .update(fillJobs)
      .set({ heartbeatAt: new Date() })
      .where(eq(fillJobs.id, jobId));
    return reply.code(200).send({ ok: true });
  });
}
