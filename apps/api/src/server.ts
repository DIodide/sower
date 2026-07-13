import { timingSafeEqual } from 'node:crypto';
import { apiCalls, applicationTasks, events, jobs } from '@sower/db';
import { asc, desc, eq } from 'drizzle-orm';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { registerAnswerLibraryRoutes } from './answer-library.js';
import { markApprovalCardSubmitted, registerDiscordRoutes } from './discord.js';
import { ingestJob } from './ingest.js';
import { runIngestionPoll } from './ingest-poll.js';
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
