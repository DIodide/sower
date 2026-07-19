import { randomUUID, timingSafeEqual } from 'node:crypto';
import {
  canTransition,
  deadlineFromIsoDate,
  type JobSpec,
  type Platform,
  type TaskPriority,
} from '@sower/core';
import {
  apiCalls,
  applicationTasks,
  documents,
  events,
  type InvestigationRunStatus,
  investigationRuns,
  type Job,
  jobs,
} from '@sower/db';
import { and, asc, desc, eq } from 'drizzle-orm';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { registerAnswerLibraryRoutes } from './answer-library.js';
import { markApprovalCardSubmitted, registerDiscordRoutes } from './discord.js';
import {
  ingestMessageLinks,
  runDiscordIngestPoll,
  type UrlOutcome,
} from './discord-ingest.js';
import { ingestJob } from './ingest.js';
import { runIngestionPoll } from './ingest-poll.js';
import { refreshIngestReply } from './ingest-reply.js';
import { triggerInvestigation } from './investigate-trigger.js';
import { requestOtp, submitOtp } from './otp-actions.js';
import {
  backfillJobFields,
  persistJobDeadline,
  processTask,
  recordJobDescription,
} from './process.js';
import {
  claimSessionRequest,
  completeSessionCapture,
  failSessionCapture,
  recordAgentHeartbeat,
  startSessionCapture,
} from './sessions-actions.js';
import { approveTask, requeueTask } from './task-actions.js';
import { transitionTask } from './transitions.js';
import type { Deps } from './types.js';

const ingestBodySchema = z.object({
  url: z.string().url(),
  source: z.string().min(1).optional(),
});

const processBodySchema = z.object({
  taskId: z.string().uuid(),
});

/** Notes cap — mirrors the dashboard's 20k text-answer cap; above it → 400. */
const NOTES_MAX_CHARS = 20_000;

// @sower/core TaskPriority: 1=high, 0=normal, -1=low.
const prioritySchema = z.union([z.literal(-1), z.literal(0), z.literal(1)]);

// PATCH-style: only provided fields are written. notes: null clears the note;
// at least one field must be present (an empty body is a 400, not a no-op).
const taskMetaBodySchema = z
  .object({
    notes: z.string().max(NOTES_MAX_CHARS).nullable().optional(),
    priority: prioritySchema.optional(),
  })
  .refine((body) => body.notes !== undefined || body.priority !== undefined, {
    message: 'provide at least one of notes, priority',
  });

// The dashboard quick-add paste box (free text; urls are extracted from it).
// 50k comfortably fits a whole job-links email; the dashboard action mirrors
// this cap so the user sees a friendly message instead of a 400.
const pasteBodySchema = z.object({
  text: z.string().min(1).max(50_000),
});

// Manual entry without a URL: company is the one required handle.
const manualIngestBodySchema = z.object({
  company: z.string().trim().min(1).max(200),
  title: z.string().trim().min(1).max(300).optional(),
  notes: z.string().max(NOTES_MAX_CHARS).optional(),
  priority: prioritySchema.optional(),
});

/**
 * Per-URL outcome simplified for the dashboard paste box: the classifier's
 * discriminated union collapsed to one flat shape the UI can render as rows.
 */
interface PasteOutcome {
  url: string;
  kind: UrlOutcome['kind'];
  taskId?: string;
  platform?: string;
  error?: string;
}

function simplifyOutcome(outcome: UrlOutcome): PasteOutcome {
  switch (outcome.kind) {
    case 'ingested':
      return {
        url: outcome.url,
        kind: 'ingested',
        taskId: outcome.taskId,
        platform: outcome.platform,
      };
    case 'duplicate':
      return {
        url: outcome.url,
        kind: 'duplicate',
        taskId: outcome.taskId ?? undefined,
      };
    case 'unsupported':
      return { url: outcome.url, kind: 'unsupported', taskId: outcome.taskId };
    case 'directory':
      return { url: outcome.url, kind: 'directory' };
    case 'error':
      return { url: outcome.url, kind: 'error', error: outcome.error };
  }
}

/**
 * Flatten the outcome tree one level: each directory contributes its own row
 * followed by its children's rows (children never nest further — directory
 * expansion stops at depth 1, see classifyAndIngest).
 */
function flattenOutcomes(outcomes: UrlOutcome[]): PasteOutcome[] {
  const flat: PasteOutcome[] = [];
  for (const outcome of outcomes) {
    flat.push(simplifyOutcome(outcome));
    if (outcome.kind === 'directory') {
      for (const child of outcome.children) {
        flat.push(simplifyOutcome(child));
      }
    }
  }
  return flat;
}

const taskParamsSchema = z.object({
  id: z.string().uuid(),
});

const otpBodySchema = z.object({
  code: z.string().min(4).max(20),
});

// Bulk discard body (the dashboard Queue page's "Discard selected").
const bulkDiscardBodySchema = z.object({
  taskIds: z.array(z.string().uuid()).min(1).max(100),
});

// Optional note body shared by single discard and mark-applied: a human note
// ("why" / "where or how I applied") stored on the DISCARD / MARK_SUBMITTED
// event. No body / empty-after-trim = exactly the note-less action.
const noteBodySchema = z
  .object({
    note: z.string().trim().max(2000).optional(),
  })
  .optional();

const tenantParamsSchema = z.object({
  tenant: z.string().min(1).max(120),
});

// The captured session the local agent reports back (cookies/CSRF are secrets —
// stored ONLY in the vault by completeSessionCapture, never in the DB or logs).
const sessionPayloadSchema = z.object({
  host: z.string().min(1),
  tenant: z.string().min(1),
  cookie: z.string().min(1),
  csrfToken: z.string().min(1),
  capturedAt: z.string().optional(),
  fingerprint: z
    .object({
      userAgent: z.string().optional(),
      chromeMajor: z.number().optional(),
      acceptLanguage: z.string().optional(),
      secChUa: z.string().optional(),
    })
    .optional(),
});

const sessionFailBodySchema = z.object({
  error: z.string().min(1).max(4000),
});

const heartbeatBodySchema = z.object({
  name: z.string().min(1).max(120),
  detail: z.string().max(200).optional(),
});

// What the investigator Cloud Run Job POSTs back — matches
// InvestigationResult / TranscriptStep in @sower/investigate (re-declared as
// types in @sower/db). applyUrl is deliberately NOT .url(): persisting the
// observability transcript must never be lost to a malformed URL — ingestJob
// failing on it lands the run in status 'error' instead.
const investigationResultSchema = z.object({
  found: z.boolean(),
  applyUrl: z.string().optional(),
  company: z.string().optional(),
  title: z.string().optional(),
  platform: z.string().optional(),
  confidence: z.enum(['high', 'medium', 'low']),
  notes: z.string(),
});

const transcriptStepSchema = z.object({
  seq: z.number(),
  kind: z.enum([
    'assistant_text',
    'tool_use',
    'tool_result',
    'result',
    'system',
  ]),
  tool: z.string().optional(),
  input: z.unknown().optional(),
  output: z.string().optional(),
  text: z.string().optional(),
  ts: z.number(),
});

// Form-mode result — matches DiscoveredForm in @sower/investigate (re-declared
// as a type in @sower/db); questions are canonical @sower/core Question[].
const discoveredQuestionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  type: z.enum(['text', 'textarea', 'file', 'select', 'multiselect']),
  required: z.boolean(),
  options: z
    .array(
      z.object({
        label: z.string(),
        value: z.union([z.string(), z.number()]),
      }),
    )
    .optional(),
});

const discoveredFormSchema = z.object({
  formFound: z.boolean(),
  applyUrl: z.string().optional(),
  company: z.string().optional(),
  title: z.string().optional(),
  // Programmatically scraped JD markdown (~20k cap in @sower/investigate;
  // 25k here leaves headroom so a boundary payload is never rejected).
  descriptionMarkdown: z.string().max(25_000).optional(),
  // Not extracted by @sower/investigate yet — accepted now so the endpoint
  // needs no change when the agent starts reporting it.
  employmentType: z.string().max(200).optional(),
  // Explicit application deadline (ISO; @sower/core extractDeadline output).
  // Unparseable values are ignored at persist time, never guessed at.
  deadline: z.string().max(64).optional(),
  // Cleaned supported-ATS posting URL when the apply flow landed on one
  // (workday/greenhouse/lever/ashby — see detectHandoffUrl). Deliberately
  // NOT .url(): a malformed value must not cost us the transcript; ingestJob
  // failing on it lands in the run's error column instead.
  handoffUrl: z.string().max(2000).optional(),
  questions: z.array(discoveredQuestionSchema),
  confidence: z.enum(['high', 'medium', 'low']),
  notes: z.string(),
});

// `kind` selects the result schema; absent means 'screenshot' so the
// pre-`kind` investigator payload keeps working unchanged.
const investigationResultBodySchema = z.union([
  z.object({
    kind: z.literal('screenshot').default('screenshot'),
    result: investigationResultSchema,
    transcript: z.array(transcriptStepSchema),
  }),
  z.object({
    kind: z.literal('form'),
    result: discoveredFormSchema,
    transcript: z.array(transcriptStepSchema),
  }),
]);

const PLATFORM_VALUES: readonly string[] = [
  'greenhouse',
  'lever',
  'ashby',
  'workday',
  'unknown',
] satisfies Platform[];

/** jobs.platform is free text in the DB; JobSpec.platform is the union. */
function asPlatform(value: string): Platform {
  return PLATFORM_VALUES.includes(value) ? (value as Platform) : 'unknown';
}

/**
 * JobSpec for a form discovered on an UNSUPPORTED job page: questions come
 * from the agent, identity (platform/tenant/url) from the job row, and
 * `discoveredByAgent` marks it machine-extracted so the dashboard badges it
 * "verify before use". The task stays NEEDS_INPUT — never auto-submitted.
 */
function buildDiscoveredJobSpec(
  job: Job,
  result: z.infer<typeof discoveredFormSchema>,
): JobSpec {
  const spec: JobSpec = {
    platform: asPlatform(job.platform),
    tenant: job.tenant ?? '',
    externalId: job.externalId ?? '',
    title: result.title ?? job.title ?? '',
    company: result.company ?? job.company ?? undefined,
    applyUrl: result.applyUrl ?? job.url,
    questions: result.questions,
    discoveredByAgent: true,
  };
  if (result.employmentType) {
    spec.employmentType = result.employmentType;
  }
  if (result.deadline) {
    const deadline = deadlineFromIsoDate(result.deadline);
    if (deadline) {
      spec.deadline = deadline;
    }
  }
  return spec;
}

/** Constant-time string comparison (length-guarded). */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

export function buildServer(deps: Deps): FastifyInstance {
  const app = Fastify({
    logger:
      deps.logger === false
        ? false
        : {
            redact: {
              paths: ['req.headers["x-api-key"]'],
              censor: '[redacted]',
            },
          },
  });

  // Every route except GET /health requires the ingest API key.
  app.addHook('preHandler', async (request, reply) => {
    const path = request.url.split('?')[0] ?? request.url;
    if (request.method === 'GET' && path === '/health') {
      return;
    }
    // POST /discord/interactions is authenticated by Ed25519 signature
    // verification inside its handler (Discord cannot send an x-api-key).
    if (request.method === 'POST' && path === '/discord/interactions') {
      return;
    }
    const apiKey = request.headers['x-api-key'];
    if (
      typeof apiKey !== 'string' ||
      !safeEqual(apiKey, deps.config.INGEST_API_KEY)
    ) {
      reply.code(401);
      return reply.send({ error: 'unauthorized' });
    }
  });

  app.get('/health', async () => ({ ok: true, env: deps.config.SOWER_ENV }));

  app.get('/tasks', async () => {
    const tasks = await deps.db
      .select({
        id: applicationTasks.id,
        state: applicationTasks.state,
        company: jobs.company,
        title: jobs.title,
        platform: jobs.platform,
        url: jobs.url,
        updatedAt: applicationTasks.updatedAt,
      })
      .from(applicationTasks)
      .innerJoin(jobs, eq(applicationTasks.jobId, jobs.id))
      .orderBy(desc(applicationTasks.updatedAt))
      .limit(50);
    return { tasks };
  });

  // Task detail: task + job + resolution + events + api_calls. The dashboard
  // mainly reads the db directly; this exists as a fallback/debugging surface.
  app.get('/tasks/:id', async (request, reply) => {
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
    const taskEvents = await deps.db
      .select()
      .from(events)
      .where(eq(events.taskId, taskId))
      .orderBy(asc(events.createdAt));
    const taskApiCalls = await deps.db
      .select()
      .from(apiCalls)
      .where(eq(apiCalls.taskId, taskId))
      .orderBy(asc(apiCalls.seq));
    return {
      task: row.task,
      job: row.job,
      resolution: row.task.resolution ?? null,
      events: taskEvents,
      apiCalls: taskApiCalls,
    };
  });

  app.post('/tasks/:id/requeue', async (request, reply) => {
    const parsed = taskParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: 'invalid task id', issues: parsed.error.issues });
    }
    const outcome = await requeueTask(deps, parsed.data.id);
    if (outcome.kind === 'not_found') {
      return reply.code(404).send({ error: 'task not found' });
    }
    if (outcome.kind === 'skipped') {
      return reply.code(200).send({ skipped: true, state: outcome.state });
    }
    return reply.code(200).send({ state: outcome.state });
  });

  // Discard a task: a human removes it from the queue (terminal DISCARDED
  // state). Allowed from every non-terminal state EXCEPT SUBMITTED/CONFIRMED —
  // an application already sent can't be "removed from the queue". Idempotent:
  // re-discarding a DISCARDED task is a 200 no-op. The optional body note
  // ("why") is stored on the DISCARD event's data.
  app.post('/tasks/:id/discard', async (request, reply) => {
    const parsed = taskParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: 'invalid task id', issues: parsed.error.issues });
    }
    const body = noteBodySchema.safeParse(request.body ?? undefined);
    if (!body.success) {
      return reply
        .code(400)
        .send({ error: 'invalid body', issues: body.error.issues });
    }
    const note = body.data?.note;
    const taskId = parsed.data.id;
    const rows = await deps.db
      .select({ state: applicationTasks.state })
      .from(applicationTasks)
      .where(eq(applicationTasks.id, taskId))
      .limit(1);
    const row = rows[0];
    if (!row) {
      return reply.code(404).send({ error: 'task not found' });
    }
    if (row.state === 'DISCARDED') {
      // Already discarded — still refresh the #ingest reply (recovers a line
      // whose earlier edit failed). Never throws.
      await refreshIngestReply(deps, taskId);
      return reply.code(200).send({ ok: true });
    }
    if (!canTransition(row.state, 'DISCARD')) {
      return reply
        .code(409)
        .send({ error: `cannot discard a task in state '${row.state}'` });
    }
    await transitionTask(deps.db, taskId, row.state, 'DISCARD', {
      reason: 'manual',
      // Omit the key entirely when absent/blank — event data stays minimal.
      ...(note ? { note } : {}),
    });
    // Best-effort: the reply line for this task flips to "discarded".
    await refreshIngestReply(deps, taskId);
    return reply.code(200).send({ ok: true });
  });

  // Restore a discarded task (the Archive's Restore / an undo after a
  // mis-click). Lands in NEEDS_INPUT — a human decides what happens next.
  // Idempotent-friendly: restoring a task that is not DISCARDED is a 409
  // unless it's NEEDS_INPUT (the state RESTORE produces), which is a 200
  // no-op so a double-clicked undo never errors.
  app.post('/tasks/:id/restore', async (request, reply) => {
    const parsed = taskParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: 'invalid task id', issues: parsed.error.issues });
    }
    const taskId = parsed.data.id;
    const rows = await deps.db
      .select({ state: applicationTasks.state })
      .from(applicationTasks)
      .where(eq(applicationTasks.id, taskId))
      .limit(1);
    const row = rows[0];
    if (!row) {
      return reply.code(404).send({ error: 'task not found' });
    }
    if (row.state === 'NEEDS_INPUT') {
      return reply.code(200).send({ ok: true });
    }
    if (row.state !== 'DISCARDED') {
      return reply
        .code(409)
        .send({ error: `cannot restore a task in state '${row.state}'` });
    }
    await transitionTask(deps.db, taskId, row.state, 'RESTORE', {
      reason: 'manual',
    });
    // Best-effort: the reply line for this task leaves "discarded".
    await refreshIngestReply(deps, taskId);
    return reply.code(200).send({ ok: true });
  });

  // Mark a task applied out of band: the human completed the application
  // themselves, so the task jumps straight to SUBMITTED. Allowed from every
  // non-terminal state EXCEPT SUBMITTED/CONFIRMED — those are 200 no-ops (it
  // is already sent, a double-click never errors) — while the archived
  // DISCARDED/DUPLICATE states are 409s (restore first). The optional body
  // note ("where/how") is stored on the MARK_SUBMITTED event's data.
  app.post('/tasks/:id/mark-applied', async (request, reply) => {
    const parsed = taskParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: 'invalid task id', issues: parsed.error.issues });
    }
    const body = noteBodySchema.safeParse(request.body ?? undefined);
    if (!body.success) {
      return reply
        .code(400)
        .send({ error: 'invalid body', issues: body.error.issues });
    }
    const note = body.data?.note;
    const taskId = parsed.data.id;
    const rows = await deps.db
      .select({ state: applicationTasks.state })
      .from(applicationTasks)
      .where(eq(applicationTasks.id, taskId))
      .limit(1);
    const row = rows[0];
    if (!row) {
      return reply.code(404).send({ error: 'task not found' });
    }
    if (row.state === 'SUBMITTED' || row.state === 'CONFIRMED') {
      return reply.code(200).send({ ok: true });
    }
    if (!canTransition(row.state, 'MARK_SUBMITTED')) {
      return reply
        .code(409)
        .send({ error: `cannot mark a task applied in state '${row.state}'` });
    }
    await transitionTask(deps.db, taskId, row.state, 'MARK_SUBMITTED', {
      reason: 'manual',
      // Omit the key entirely when absent/blank — event data stays minimal.
      ...(note ? { note } : {}),
    });
    // Best-effort: the reply line for this task flips to "applied".
    await refreshIngestReply(deps, taskId);
    return reply.code(200).send({ ok: true });
  });

  // Bulk discard (the Queue page's checkbox form). Per-task tolerant: a
  // missing or undiscardable task lands in `skipped` with a reason and never
  // fails the batch. refreshIngestReply is cheap and idempotent, so it simply
  // runs once per discarded task.
  app.post('/tasks/discard', async (request, reply) => {
    const parsed = bulkDiscardBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: 'invalid body', issues: parsed.error.issues });
    }
    let discarded = 0;
    const skipped: { id: string; reason: string }[] = [];
    for (const taskId of parsed.data.taskIds) {
      const rows = await deps.db
        .select({ state: applicationTasks.state })
        .from(applicationTasks)
        .where(eq(applicationTasks.id, taskId))
        .limit(1);
      const row = rows[0];
      if (!row) {
        skipped.push({ id: taskId, reason: 'task not found' });
        continue;
      }
      if (row.state === 'DISCARDED') {
        skipped.push({ id: taskId, reason: 'already discarded' });
        continue;
      }
      if (!canTransition(row.state, 'DISCARD')) {
        skipped.push({
          id: taskId,
          reason: `cannot discard a task in state '${row.state}'`,
        });
        continue;
      }
      try {
        await transitionTask(deps.db, taskId, row.state, 'DISCARD', {
          reason: 'manual',
        });
        discarded += 1;
        await refreshIngestReply(deps, taskId);
      } catch (error) {
        skipped.push({
          id: taskId,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return reply.code(200).send({ ok: true, discarded, skipped });
  });

  // User-facing task metadata (notes + priority), PATCH-style over POST: only
  // the provided fields are written (notes: null clears the note). No events
  // row — note edits are chatty user annotations, not pipeline state. For the
  // same reason updatedAt is left alone: annotating a task is not activity,
  // and touching it would re-sort the dashboard's recency-ordered lists under
  // the user's hands.
  app.post('/tasks/:id/meta', async (request, reply) => {
    const params = taskParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply
        .code(400)
        .send({ error: 'invalid task id', issues: params.error.issues });
    }
    const body = taskMetaBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply
        .code(400)
        .send({ error: 'invalid body', issues: body.error.issues });
    }
    const taskId = params.data.id;
    const rows = await deps.db
      .select({ id: applicationTasks.id })
      .from(applicationTasks)
      .where(eq(applicationTasks.id, taskId))
      .limit(1);
    if (!rows[0]) {
      return reply.code(404).send({ error: 'task not found' });
    }
    const set: {
      notes?: string | null;
      priority?: TaskPriority;
    } = {};
    if (body.data.notes !== undefined) {
      set.notes = body.data.notes;
    }
    if (body.data.priority !== undefined) {
      set.priority = body.data.priority;
    }
    await deps.db
      .update(applicationTasks)
      .set(set)
      .where(eq(applicationTasks.id, taskId));
    return reply.code(200).send({ ok: true });
  });

  // Manually start the browser agent (Tier-2 form-discovery investigation) on
  // a maybe-job the pipeline can't process. Eligible when the task is still
  // actionable (not DISCARDED/SUBMITTED/CONFIRMED) and the agent can help:
  // the job's platform is 'unknown' (unsupported) OR the job was recorded
  // from a screenshot (a kind='screenshot' document exists for it).
  // triggerInvestigation self-gates on config and never throws; `fired`
  // reports whether a run actually started.
  app.post('/tasks/:id/investigate', async (request, reply) => {
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
    if (
      state === 'DISCARDED' ||
      state === 'SUBMITTED' ||
      state === 'CONFIRMED'
    ) {
      return reply
        .code(400)
        .send({ error: `cannot investigate a task in state '${state}'` });
    }
    let eligible = row.job.platform === 'unknown';
    if (!eligible) {
      // Supported platform: only a screenshot-recorded job needs the agent.
      const shots = await deps.db
        .select({ id: documents.id })
        .from(documents)
        .where(
          and(
            eq(documents.jobId, row.job.id),
            eq(documents.kind, 'screenshot'),
          ),
        )
        .limit(1);
      eligible = shots[0] !== undefined;
    }
    if (!eligible) {
      return reply.code(400).send({
        error: `task is not eligible for investigation: platform '${row.job.platform}' is supported and the job has no screenshot`,
      });
    }
    const fired = await triggerInvestigation(deps, taskId);
    if (fired) {
      // Best-effort: the #ingest reply shows "discovering form…" right away.
      await refreshIngestReply(deps, taskId);
    }
    return reply.code(200).send({ ok: true, fired });
  });

  // Approve a REVIEW task: fill but never SUBMIT. Greenhouse/lever/ashby build
  // and record the payload with zero network I/O (dry-run); Workday drives a
  // real calypso fill via the captured session and STOPS before finalize.
  app.post('/tasks/:id/approve', async (request, reply) => {
    const parsed = taskParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: 'invalid task id', issues: parsed.error.issues });
    }
    const outcome = await approveTask(deps, parsed.data.id);
    if (outcome.kind === 'not_found') {
      return reply.code(404).send({ error: 'task not found' });
    }
    if (outcome.kind === 'skipped') {
      return reply.code(200).send({ skipped: true, state: outcome.state });
    }
    if (outcome.kind === 'failed') {
      return reply.code(500).send({ error: outcome.error });
    }
    // Best-effort: reflect the approval on the task's Discord card with the
    // honest per-mode verdict (no-op when Discord is disabled or no card).
    await markApprovalCardSubmitted(deps, outcome.approval, {
      mode: outcome.mode,
      note: outcome.note,
    });
    return reply.code(200).send({
      state: outcome.state,
      mode: outcome.mode,
      dryRun: outcome.dryRun,
      note: outcome.note,
      payloadSummary: outcome.payloadSummary,
    });
  });

  // Park a FILLING task in AWAITING_OTP and post the Discord OTP card. The
  // browser tier calls this when it hits an email-verification wall.
  app.post('/tasks/:id/request-otp', async (request, reply) => {
    const parsed = taskParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: 'invalid task id', issues: parsed.error.issues });
    }
    const outcome = await requestOtp(deps, parsed.data.id);
    if (outcome.kind === 'not_found') {
      return reply.code(404).send({ error: 'task not found' });
    }
    if (outcome.kind === 'skipped') {
      return reply.code(200).send({ skipped: true, state: outcome.state });
    }
    return reply.code(200).send({ state: outcome.state });
  });

  // Deliver a one-time code to an AWAITING_OTP task (dashboard or manual
  // path; the Discord modal is handled by /discord/interactions instead).
  app.post('/tasks/:id/otp', async (request, reply) => {
    const params = taskParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply
        .code(400)
        .send({ error: 'invalid task id', issues: params.error.issues });
    }
    const body = otpBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply
        .code(400)
        .send({ error: 'invalid body', issues: body.error.issues });
    }
    const outcome = await submitOtp(deps, params.data.id, body.data.code);
    if (outcome.kind === 'not_found') {
      return reply.code(404).send({ error: 'task not found' });
    }
    if (outcome.kind === 'invalid_code') {
      return reply
        .code(400)
        .send({ error: 'not a valid one-time code (4-10 letters/digits)' });
    }
    if (outcome.kind === 'skipped') {
      return reply.code(200).send({ skipped: true, state: outcome.state });
    }
    return reply.code(200).send({ state: outcome.state });
  });

  // Tier-2 investigation callback: the investigator Cloud Run Job POSTs its
  // outcome here (x-api-key gated by the global preHandler like every route
  // except GET /health and POST /discord/interactions). Two kinds share the
  // endpoint (body.kind, default 'screenshot'):
  // - screenshot: persists the transcript on the task's latest run and, when
  //   a real apply URL was found, feeds it into the normal ingest pipeline.
  // - form: persists the run and, when a form was discovered on the
  //   unsupported page, writes an agent-discovered JobSpec onto THIS task
  //   (which stays NEEDS_INPUT — human-verified, never auto-submitted).
  // Idempotent: a Job retry re-updates the latest run; ingestJob dedupes the
  // URL and a re-POSTed form just rewrites the same jobSpec.
  app.post('/tasks/:id/investigation-result', async (request, reply) => {
    const params = taskParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply
        .code(400)
        .send({ error: 'invalid task id', issues: params.error.issues });
    }
    const body = investigationResultBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply
        .code(400)
        .send({ error: 'invalid body', issues: body.error.issues });
    }
    const taskId = params.data.id;
    const kind = body.data.kind;

    // Latest run for this task (inserted by the trigger); if the trigger's
    // insert was lost (or the Job was started manually), self-heal with one.
    const runs = await deps.db
      .select({ id: investigationRuns.id })
      .from(investigationRuns)
      .where(eq(investigationRuns.taskId, taskId))
      .orderBy(desc(investigationRuns.startedAt))
      .limit(1);
    let runId = runs[0]?.id;
    if (runId === undefined) {
      const inserted = await deps.db
        .insert(investigationRuns)
        .values({ taskId, status: 'running', kind })
        .returning({ id: investigationRuns.id });
      runId = inserted[0]?.id;
    }

    if (body.data.kind === 'form') {
      const { result, transcript } = body.data;
      let status: InvestigationRunStatus = result.formFound
        ? 'found'
        : 'not_found';
      let formError: string | null = null;
      let handoff:
        | { taskId?: string; jobId: string; duplicate: boolean }
        | undefined;

      // The task+job row is needed on EVERY outcome: the scraped metadata
      // (title/company/JD markdown/deadline) persists regardless of whether
      // a fillable form was found. Dropping it in the formFound:false case
      // was a live data-loss bug — a correct scrape of the Salesforce
      // posting (whose apply hop dead-ended on a Workday sign-in) and of a
      // Google-Forms page (widgets aren't native controls) both left
      // jobs.title/company NULL and the JD unrecorded.
      const rows = await deps.db
        .select({ task: applicationTasks, job: jobs })
        .from(applicationTasks)
        .innerJoin(jobs, eq(applicationTasks.jobId, jobs.id))
        .where(eq(applicationTasks.id, taskId))
        .limit(1);
      const row = rows[0];
      if (!row) {
        // Transcript persistence must never be lost to a missing task row.
        status = 'error';
        formError = result.formFound
          ? 'task not found; discovered form not written'
          : 'task not found; scraped metadata not written';
      } else {
        const job = row.job;
        if (result.formFound) {
          const spec = buildDiscoveredJobSpec(job, result);
          // Write the machine-extracted spec onto THIS task. No state change:
          // it stays NEEDS_INPUT (unknown platform — a human must verify the
          // questions and drive any submission).
          await deps.db
            .update(applicationTasks)
            .set({ jobSpec: spec, updatedAt: new Date() })
            .where(eq(applicationTasks.id, taskId));
          await deps.db.insert(events).values({
            taskId,
            type: 'FORM_DISCOVERED',
            data: {
              questionCount: result.questions.length,
              company: spec.company,
              title: spec.title,
              confidence: result.confidence,
            },
          });
        } else {
          await deps.db.insert(events).values({
            taskId,
            type: 'FORM_NOT_FOUND',
            data: { notes: result.notes, confidence: result.confidence },
          });
          // No form ⇒ no fresh spec to hang employmentType on — store it
          // into an EXISTING spec only (a questions-less minimal spec would
          // masquerade as a discovered form); with none, skip it. The
          // title/company/JD/deadline persistence below is what matters.
          if (result.employmentType && row.task.jobSpec) {
            await deps.db
              .update(applicationTasks)
              .set({
                jobSpec: {
                  ...row.task.jobSpec,
                  employmentType: result.employmentType,
                },
                updatedAt: new Date(),
              })
              .where(eq(applicationTasks.id, taskId));
          }
        }

        // Persist the scraped metadata on BOTH outcomes. An unsupported-link
        // ingest records no title/company, so the dashboard showed
        // "— untitled role" — fill the blanks from the agent's finding
        // (never overwriting ingest-recorded values), store the scraped JD
        // markdown as a versioned job_descriptions row exactly like
        // processTask does for adapter descriptions, and record an explicit
        // deadline (agent-reported or parsed from the JD) when the jobs row
        // has none yet.
        await backfillJobFields(deps.db, job, {
          company: result.company,
          title: result.title,
        });
        await recordJobDescription(deps.db, job.id, result.descriptionMarkdown);
        await persistJobDeadline(deps.db, job, {
          deadline: result.deadline,
          description: result.descriptionMarkdown,
        });

        // Supported-platform handoff: the apply flow landed on an ATS an
        // adapter CAN ingest (the Workday popup case). Feed it through the
        // normal ingest pipeline — dedupe makes a re-POST safe — and, when a
        // NEW supported task results, annotate THIS task's timeline. The
        // original task deliberately stays parked with its metadata: a
        // Workday task needs a captured session, so the human stays in the
        // loop and can discard this one once the real task is queued.
        if (result.handoffUrl) {
          try {
            const ingested = await ingestJob(deps, {
              url: result.handoffUrl,
              source: 'discord-investigation',
            });
            const platformRows = await deps.db
              .select({ platform: jobs.platform })
              .from(jobs)
              .where(eq(jobs.id, ingested.jobId))
              .limit(1);
            const platform = platformRows[0]?.platform ?? 'unknown';
            if (!ingested.duplicate && platform !== 'unknown') {
              await deps.db.insert(events).values({
                taskId,
                type: 'HANDOFF',
                data: {
                  handoffUrl: result.handoffUrl,
                  jobId: ingested.jobId,
                  taskId: ingested.taskId,
                  platform,
                },
              });
            }
            handoff = {
              jobId: ingested.jobId,
              ...(ingested.taskId ? { taskId: ingested.taskId } : {}),
              duplicate: ingested.duplicate,
            };
          } catch (error) {
            // An ingest hiccup must not force a Cloud Run Job retry: record
            // it on the run (metadata above is already persisted) and 200.
            status = 'error';
            formError = error instanceof Error ? error.message : String(error);
          }
        }
      }

      if (runId !== undefined) {
        await deps.db
          .update(investigationRuns)
          .set({
            kind: 'form',
            status,
            result,
            transcript,
            error: formError,
            finishedAt: new Date(),
          })
          .where(eq(investigationRuns.id, runId));
      }

      // Edit the #ingest reply that announced this task so it reflects the
      // outcome (form discovered / no form found). Never throws — a Discord
      // failure must not change the 200 the investigator Job relies on.
      await refreshIngestReply(deps, taskId);

      return reply
        .code(200)
        .send(handoff !== undefined ? { ok: true, handoff } : { ok: true });
    }

    const { result, transcript } = body.data;

    let status: InvestigationRunStatus = result.found ? 'found' : 'not_found';
    let foundJobId: string | undefined;
    let ingestError: string | null = null;

    if (result.found && result.applyUrl) {
      try {
        // Feed the located posting into the normal pipeline (dedupe + park/
        // enqueue in one place — a re-POST of the same URL is a duplicate).
        const ingested = await ingestJob(deps, {
          url: result.applyUrl,
          source: 'discord-investigation',
        });
        foundJobId = ingested.jobId;
        // Timeline annotation on the screenshot task (a direct events insert,
        // not a transition — the task's state is unchanged).
        await deps.db.insert(events).values({
          taskId,
          type: 'INVESTIGATION_FOUND',
          data: {
            applyUrl: result.applyUrl,
            foundJobId,
            company: result.company,
            title: result.title,
            platform: result.platform,
          },
        });
      } catch (error) {
        // An ingest hiccup must not force a Cloud Run Job retry: record the
        // failure on the run (transcript still persisted below) and 200.
        status = 'error';
        ingestError = error instanceof Error ? error.message : String(error);
      }
    } else {
      // No URL to ingest — still annotate the timeline with the outcome.
      await deps.db.insert(events).values({
        taskId,
        type: 'INVESTIGATION_DONE',
        data: { notes: result.notes, confidence: result.confidence },
      });
    }

    if (runId !== undefined) {
      await deps.db
        .update(investigationRuns)
        .set({
          kind: 'screenshot',
          status,
          result,
          transcript,
          foundJobId: foundJobId ?? null,
          error: ingestError,
          finishedAt: new Date(),
        })
        .where(eq(investigationRuns.id, runId));
    }

    // Edit the #ingest reply that announced this screenshot task so it
    // reflects the investigation outcome. Never throws (see above).
    await refreshIngestReply(deps, taskId);

    return reply
      .code(200)
      .send(foundJobId !== undefined ? { ok: true, foundJobId } : { ok: true });
  });

  // Human verification of an agent-discovered form (the dashboard's "Verify"
  // button): marks jobSpec.formVerified, records a FORM_VERIFIED event, and
  // edits the #ingest reply to the verified line. Idempotent — re-verifying
  // an already-verified form succeeds without duplicating the event.
  app.post('/tasks/:id/verify-form', async (request, reply) => {
    const params = taskParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply
        .code(400)
        .send({ error: 'invalid task id', issues: params.error.issues });
    }
    const taskId = params.data.id;
    const rows = await deps.db
      .select()
      .from(applicationTasks)
      .where(eq(applicationTasks.id, taskId))
      .limit(1);
    const task = rows[0];
    if (!task) {
      return reply.code(404).send({ error: 'task not found' });
    }
    const spec = task.jobSpec;
    if (!spec?.discoveredByAgent) {
      return reply.code(400).send({ error: 'no discovered form to verify' });
    }
    if (spec.formVerified !== true) {
      await deps.db
        .update(applicationTasks)
        .set({
          jobSpec: { ...spec, formVerified: true },
          updatedAt: new Date(),
        })
        .where(eq(applicationTasks.id, taskId));
      await deps.db.insert(events).values({
        taskId,
        type: 'FORM_VERIFIED',
        data: {
          questionCount: spec.questions.length,
          company: spec.company,
          title: spec.title,
        },
      });
    }
    // Re-run the refresh even when already verified: it recovers a reply
    // whose earlier edit failed. Never throws.
    await refreshIngestReply(deps, taskId);
    return reply.code(200).send({ ok: true });
  });

  app.post('/ingest', async (request, reply) => {
    const parsed = ingestBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: 'invalid body', issues: parsed.error.issues });
    }
    const result = await ingestJob(deps, {
      url: parsed.data.url,
      source: parsed.data.source,
    });
    if (result.duplicate) {
      return reply.code(200).send({ duplicate: true, jobId: result.jobId });
    }
    return reply.code(201).send({
      jobId: result.jobId,
      taskId: result.taskId,
      state: result.state,
    });
  });

  // Dashboard quick-add paste box: run the same ingress-agnostic classifier
  // the Discord #ingest poll uses (shim-unwrap, pre-resolve detect, dedupe,
  // directory expansion, unsupported parking + investigation, never-drop) over
  // a pasted text blob, with jobs.source stamped 'manual'. Text with no URLs
  // is a 200 with zeros — the UI messages it, it is not an error.
  app.post('/ingest/paste', async (request, reply) => {
    const parsed = pasteBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: 'invalid body', issues: parsed.error.issues });
    }
    const summary = await ingestMessageLinks(deps, parsed.data.text, 'manual');
    return reply.code(200).send({
      ok: true,
      urls: summary.urls,
      ingested: summary.ingested,
      duplicates: summary.duplicates,
      unsupported: summary.unsupported,
      directories: summary.directories,
      errors: summary.errors,
      // URLs beyond the per-message cap that were NOT processed — the UI
      // tells the user to paste the rest separately instead of silently
      // dropping them.
      truncated: summary.truncatedUrls ?? 0,
      outcomes: flattenOutcomes(summary.outcomes),
    });
  });

  // Manual entry with NO url (a recruiter conversation, a job seen on paper):
  // record it under a manual://<uuid> placeholder URL — canonicalizeUrl keeps
  // non-http schemes intact and detectPlatform reports unknown, so ingestJob
  // records + parks the task NEEDS_INPUT, which is right: it needs the user.
  // resolve:false — there is nothing to GET. Notes/priority land on the
  // freshly created task in the same request.
  app.post('/ingest/manual', async (request, reply) => {
    const parsed = manualIngestBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: 'invalid body', issues: parsed.error.issues });
    }
    const result = await ingestJob(deps, {
      url: `manual://${randomUUID()}`,
      source: 'manual',
      resolve: false,
      company: parsed.data.company,
      title: parsed.data.title,
    });
    if (result.duplicate) {
      // Unreachable in practice (the uuid is random); surface, never lie.
      return reply
        .code(500)
        .send({ error: 'manual job unexpectedly deduplicated' });
    }
    const { notes, priority } = parsed.data;
    if (notes !== undefined || priority !== undefined) {
      const set: { updatedAt: Date; notes?: string; priority?: TaskPriority } =
        { updatedAt: new Date() };
      if (notes !== undefined) {
        set.notes = notes;
      }
      if (priority !== undefined) {
        set.priority = priority;
      }
      await deps.db
        .update(applicationTasks)
        .set(set)
        .where(eq(applicationTasks.id, result.taskId));
    }
    return reply
      .code(201)
      .send({ ok: true, taskId: result.taskId, jobId: result.jobId });
  });

  app.post('/tasks/process', async (request, reply) => {
    const parsed = processBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send({ error: 'invalid body', issues: parsed.error.issues });
    }
    const outcome = await processTask(deps, parsed.data.taskId);
    if (outcome.kind === 'not_found') {
      // 200 so Cloud Tasks never retries a delivery for a deleted task.
      return reply.code(200).send({ notFound: true });
    }
    if (outcome.kind === 'skipped') {
      return reply.code(200).send({ skipped: true, state: outcome.state });
    }
    if (outcome.kind === 'failed') {
      if (outcome.gaveUp) {
        // Stop Cloud Tasks retries once we have given up.
        return reply.code(200).send({
          gaveUp: true,
          error: outcome.error,
          attempt: outcome.attempt,
        });
      }
      // 500 so Cloud Tasks retries the task.
      return reply
        .code(500)
        .send({ error: outcome.error, attempt: outcome.attempt });
    }
    if (outcome.kind === 'auto_discarded') {
      // A full-time posting the rule discarded is a FINAL outcome: 200 so
      // Cloud Tasks never re-delivers (a retry would just re-parse a job we
      // deliberately removed from the queue).
      return reply.code(200).send({
        autoDiscarded: true,
        state: outcome.state,
        employmentType: outcome.employmentType,
      });
    }
    return reply.code(200).send({
      state: outcome.state,
      resolved: outcome.resolved,
      missing: outcome.missing,
    });
  });

  // Poll the configured Summer 2027 source(s), normalize + filter by term, and
  // auto-ingest listings on any supported platform (greenhouse/ashby/lever/
  // workday) with a resolvable tenant. Records one ingestion_runs row. Kept at
  // this path so the existing Cloud Scheduler job needs no re-point.
  app.post('/sources/simplify/poll', async () => {
    return runIngestionPoll(deps);
  });

  // Poll the Discord #ingest channel: classify + ingest any job links pasted
  // there, react + reply. No-op when Discord / the ingest channel is unset.
  app.post('/sources/discord/poll', async () => {
    return runDiscordIngestPoll(deps);
  });

  // --- Workday session bridge (dashboard <-> local headful capture agent) ---

  // Request a headful browser-session capture for a parked Workday task's
  // tenant. The local agent picks it up; nothing headful runs in the cloud.
  app.post('/tasks/:id/start', async (request, reply) => {
    const params = taskParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply
        .code(400)
        .send({ error: 'invalid task id', issues: params.error.issues });
    }
    const outcome = await startSessionCapture(deps, params.data.id);
    if (outcome.kind === 'not_found') {
      return reply.code(404).send({ error: 'task not found' });
    }
    if (outcome.kind === 'unsupported') {
      return reply.code(400).send({
        error: `start is Workday-only; task platform is '${outcome.platform}'`,
      });
    }
    if (outcome.kind === 'no_storage') {
      return reply.code(503).send({
        error: 'vault storage not configured; cannot provision account',
      });
    }
    return reply
      .code(200)
      .send({ tenant: outcome.tenant, status: outcome.status });
  });

  // Local agent: claim one pending capture request (returns the credential to
  // pre-fill). Empty when nothing is pending.
  app.post('/sessions/claim', async (_request, reply) => {
    const outcome = await claimSessionRequest(deps);
    if (outcome.kind === 'empty') {
      return reply.code(200).send({ empty: true });
    }
    return reply.code(200).send({
      tenant: outcome.tenant,
      host: outcome.host,
      loginUrl: outcome.loginUrl,
      email: outcome.email,
      password: outcome.password,
    });
  });

  // Local agent: report a captured+verified session. Stored in the vault and the
  // tenant's parked tasks are re-enqueued.
  app.post('/sessions/:tenant/complete', async (request, reply) => {
    const params = tenantParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply
        .code(400)
        .send({ error: 'invalid tenant', issues: params.error.issues });
    }
    const body = sessionPayloadSchema.safeParse(request.body);
    if (!body.success) {
      return reply
        .code(400)
        .send({ error: 'invalid session', issues: body.error.issues });
    }
    const result = await completeSessionCapture(
      deps,
      params.data.tenant,
      body.data,
    );
    return reply
      .code(200)
      .send({ status: 'active', requeued: result.requeued });
  });

  // Local agent: report a failed capture (verify failed / timed out).
  app.post('/sessions/:tenant/fail', async (request, reply) => {
    const params = tenantParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply
        .code(400)
        .send({ error: 'invalid tenant', issues: params.error.issues });
    }
    const body = sessionFailBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply
        .code(400)
        .send({ error: 'invalid body', issues: body.error.issues });
    }
    await failSessionCapture(deps, params.data.tenant, body.data.error);
    return reply.code(200).send({ status: 'failed' });
  });

  // Local agent liveness ping (dashboard shows "agent last seen").
  app.post('/sessions/heartbeat', async (request, reply) => {
    const body = heartbeatBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply
        .code(400)
        .send({ error: 'invalid body', issues: body.error.issues });
    }
    await recordAgentHeartbeat(deps, body.data.name, body.data.detail);
    return reply.code(200).send({ ok: true });
  });

  // /answer-library CRUD (company-scoped answer library; x-api-key like all
  // other routes via the server-wide preHandler above).
  registerAnswerLibraryRoutes(app, deps);

  // POST /discord/interactions (signature-authenticated, raw-body parsed).
  registerDiscordRoutes(app, deps);

  return app;
}
