import { ANSWER_MAX_CHARS, saveAnswersToBank } from '@sower/answers';
import { applicationTasks, jobs } from '@sower/db';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { computeResolution, resolveDiscoveredTask } from './process.js';
import type { Deps } from './types.js';

/**
 * POST /tasks/:id/answers — SET answers for a task's questions from outside
 * the dashboard (the sower CLI's `answer set`). The write itself is the
 * dashboard form's exact path — @sower/answers saveAnswersToBank: question
 * ids must belong to THIS task, select/multiselect values must match the
 * question's options, file answers are document ids of the question's
 * kind, text answers are company-scoped unless scope 'global', 20k cap —
 * so the two surfaces can never store answers differently. ALL-OR-NOTHING:
 * a single bad answer is a 400 and nothing is written.
 *
 * After the write the task is re-resolved so the caller learns what is
 * still missing:
 * - agent-discovered specs / unknown-platform jobs (no adapter, never
 *   enqueued) → resolveDiscoveredTask: the stored resolution is refreshed
 *   IN PLACE and a RESOLVED_* event recorded (`persisted: true`);
 * - adapter-flowing tasks → the dashboard's plain "Save answers" semantics:
 *   the stored resolution stays process-owned and the response carries a
 *   PREVIEW of the next run's resolution (`persisted: false`); `sower
 *   requeue` re-runs the task for real.
 * x-api-key via the server-wide preHandler, like every other route.
 */

const taskParamsSchema = z.object({
  id: z.string().uuid(),
});

const valueSchema = z.string().max(ANSWER_MAX_CHARS);

const bodySchema = z.object({
  answers: z
    .array(
      z.object({
        // A jobSpec question id (free text, validated against the spec by
        // the writer — never a uuid).
        questionId: z.string().min(1).max(200),
        value: z.union([valueSchema, z.array(valueSchema).max(200)]),
        scope: z.enum(['company', 'global']).optional(),
      }),
    )
    .min(1)
    .max(200),
});

export function registerTaskAnswerRoutes(
  app: FastifyInstance,
  deps: Deps,
): void {
  app.post('/tasks/:id/answers', async (request, reply) => {
    const params = taskParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply
        .code(400)
        .send({ error: 'invalid task id', issues: params.error.issues });
    }
    const body = bodySchema.safeParse(request.body);
    if (!body.success) {
      return reply
        .code(400)
        .send({ error: 'invalid body', issues: body.error.issues });
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
    const spec = row.task.jobSpec;
    if (
      !spec ||
      !Array.isArray(spec.questions) ||
      spec.questions.length === 0
    ) {
      return reply.code(409).send({ error: 'task has no questions to answer' });
    }

    const outcome = await saveAnswersToBank(
      deps.db,
      {
        questions: spec.questions,
        company: row.job.company ?? spec.company,
        answers: body.data.answers,
      },
      { allOrNothing: true },
    );
    if (outcome.errors.length > 0) {
      return reply
        .code(400)
        .send({ error: 'invalid answers', issues: outcome.errors });
    }

    const discovered =
      spec.discoveredByAgent === true || row.job.platform === 'unknown';
    if (discovered) {
      const resolved = await resolveDiscoveredTask(deps, taskId);
      if (resolved.kind === 'resolved') {
        return reply.code(200).send({
          saved: outcome.saved.length,
          resolution: {
            resolved: resolved.resolution.resolved.length,
            missing: resolved.resolution.missing.length,
            requiredMissing: resolved.resolution.requiredMissingCount,
            persisted: true,
          },
        });
      }
      // not_found / no_questions cannot follow the checks above; fall
      // through to the preview rather than hide the saved answers.
    }
    const preview = await computeResolution(deps, row.job, spec);
    return reply.code(200).send({
      saved: outcome.saved.length,
      resolution: {
        resolved: preview.resolved.length,
        missing: preview.missing.length,
        requiredMissing: preview.requiredMissingCount,
        persisted: false,
      },
    });
  });
}
