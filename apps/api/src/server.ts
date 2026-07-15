import { timingSafeEqual } from 'node:crypto';
import type { JobSpec, Platform } from '@sower/core';
import {
  apiCalls,
  applicationTasks,
  events,
  type InvestigationRunStatus,
  investigationRuns,
  type Job,
  jobs,
} from '@sower/db';
import { asc, desc, eq } from 'drizzle-orm';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { registerAnswerLibraryRoutes } from './answer-library.js';
import { markApprovalCardSubmitted, registerDiscordRoutes } from './discord.js';
import { runDiscordIngestPoll } from './discord-ingest.js';
import { ingestJob } from './ingest.js';
import { runIngestionPoll } from './ingest-poll.js';
import { refreshIngestReply } from './ingest-reply.js';
import { requestOtp, submitOtp } from './otp-actions.js';
import { processTask } from './process.js';
import {
  claimSessionRequest,
  completeSessionCapture,
  failSessionCapture,
  recordAgentHeartbeat,
  startSessionCapture,
} from './sessions-actions.js';
import { approveTask, requeueTask } from './task-actions.js';
import type { Deps } from './types.js';

const ingestBodySchema = z.object({
  url: z.string().url(),
  source: z.string().min(1).optional(),
});

const processBodySchema = z.object({
  taskId: z.string().uuid(),
});

const taskParamsSchema = z.object({
  id: z.string().uuid(),
});

const otpBodySchema = z.object({
  code: z.string().min(4).max(20),
});

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
  return {
    platform: asPlatform(job.platform),
    tenant: job.tenant ?? '',
    externalId: job.externalId ?? '',
    title: result.title ?? job.title ?? '',
    company: result.company ?? job.company ?? undefined,
    applyUrl: result.applyUrl ?? job.url,
    questions: result.questions,
    discoveredByAgent: true,
  };
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

      if (result.formFound) {
        const rows = await deps.db
          .select({ job: jobs })
          .from(applicationTasks)
          .innerJoin(jobs, eq(applicationTasks.jobId, jobs.id))
          .where(eq(applicationTasks.id, taskId))
          .limit(1);
        const job = rows[0]?.job;
        if (job) {
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
          // Transcript persistence must never be lost to a missing task row.
          status = 'error';
          formError = 'task not found; discovered form not written';
        }
      } else {
        await deps.db.insert(events).values({
          taskId,
          type: 'FORM_NOT_FOUND',
          data: { notes: result.notes, confidence: result.confidence },
        });
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

      return reply.code(200).send({ ok: true });
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
