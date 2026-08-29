import type { BankEntry, BankValue } from '@sower/answers';
import type {
  JobSpec,
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
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
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
  return spec.questions.map((question, i) => {
    const summary = summaries[i];
    let values: string[] | null = null;
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
    return fill;
  });
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
    .from(documents);
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
    applyUrl: spec?.applyUrl ?? row.job.url,
    company: identity.company,
    title: identity.title,
    questions: buildFillQuestions(spec, row.task.resolution ?? null, {
      bank,
      company: company ?? undefined,
      docByPath,
    }),
  };
}

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
    if (row.job.platform !== 'greenhouse') {
      return reply.code(409).send({
        error: `browser fill is greenhouse-only (v1); task platform is '${row.job.platform}'`,
      });
    }
    if (!FILLABLE_STATES.includes(row.task.state)) {
      return reply
        .code(409)
        .send({ error: `cannot fill a task in state '${row.task.state}'` });
    }
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
