import { timingSafeEqual } from 'node:crypto';
import { apiCalls, applicationTasks, events, jobs } from '@sower/db';
import { detectPlatform } from '@sower/platforms';
import { fetchSimplifyListings, filterListings } from '@sower/sources';
import { asc, desc, eq } from 'drizzle-orm';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ingestJob } from './ingest.js';
import { processTask } from './process.js';
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

  // Approve a REVIEW task: DRY-RUN submit only. The payload is constructed
  // and recorded (api_calls, phase 'submit_dryrun') — never sent anywhere.
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
    return reply.code(200).send({
      state: outcome.state,
      dryRun: outcome.dryRun,
      payloadSummary: outcome.payloadSummary,
    });
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

  app.post('/sources/simplify/poll', async () => {
    const { config } = deps;
    const terms = config.SIMPLIFY_TERMS.split(',')
      .map((term) => term.trim())
      .filter((term) => term.length > 0);

    const listings = await fetchSimplifyListings();
    const filtered = await filterListings(listings, {
      terms,
      activeOnly: true,
      max: config.SIMPLIFY_MAX_PER_RUN * 5,
    });

    // Only greenhouse is supported end-to-end for now, and only when the
    // tenant is known (gh_jid on custom domains cannot be discovered).
    const greenhouse = filtered.filter((listing) => {
      const ref = detectPlatform(listing.url);
      return ref.platform === 'greenhouse' && ref.tenant !== null;
    });
    const batch = greenhouse.slice(0, config.SIMPLIFY_MAX_PER_RUN);

    let ingested = 0;
    let duplicates = 0;
    for (const listing of batch) {
      const result = await ingestJob(deps, {
        url: listing.url,
        source: 'simplify',
        company: listing.company_name,
        title: listing.title,
        terms: listing.terms,
      });
      if (result.duplicate) {
        duplicates += 1;
      } else {
        ingested += 1;
      }
    }

    return {
      scanned: filtered.length,
      matchedGreenhouse: greenhouse.length,
      ingested,
      duplicates,
    };
  });

  return app;
}
