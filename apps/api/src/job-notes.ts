import { applicationTasks, jobNotes } from '@sower/db';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { mirrorTaskScratchpad } from './portfolio-scratchpad.js';
import type { Deps } from './types.js';

/**
 * Job-notes scratchpad routes: create/update/delete the user's notes about a
 * job, each optionally TIED to one of the task's jobSpec questions. Every
 * mutation regenerates + pushes the portfolio scratchpad mirror IN FULL
 * (portfolio-scratchpad.ts) and reports the outcome as `sync` — a GitHub
 * failure NEVER fails the request: the note is in the DB (the source of
 * truth) and the next mutation re-mirrors the whole file. All routes
 * require x-api-key via the server-wide preHandler. The dashboard panel
 * autosaves on an 800ms debounce, so a typing burst can update (and
 * re-mirror) several times — deliberately NO server-side debounce: each
 * mirror is a full rewrite, so the last one always wins.
 */

const taskParamsSchema = z.object({
  id: z.string().uuid(),
});

const noteParamsSchema = z.object({
  id: z.string().uuid(),
  noteId: z.string().uuid(),
});

// Body cap mirrors the task-notes / answer 20k cap; questionId is a jobSpec
// question id (free text, validated against the spec below — never a uuid).
const createBodySchema = z.object({
  body: z.string().trim().min(1).max(20_000),
  questionId: z.string().max(200).optional(),
});

// PATCH-style update: only provided fields change. questionId null CLEARS
// the tie (a note demoted back to general); at least one field must be
// present, like the task-meta route.
const updateBodySchema = z
  .object({
    body: z.string().trim().min(1).max(20_000).optional(),
    questionId: z.string().max(200).nullable().optional(),
  })
  .refine(
    (patch) => patch.body !== undefined || patch.questionId !== undefined,
    { message: 'provide at least one of body, questionId' },
  );

export function registerJobNoteRoutes(app: FastifyInstance, deps: Deps): void {
  // Add a note. A provided questionId must name one of THIS task's jobSpec
  // questions — anything else is a 400, so a note can never point at a
  // question the task does not have.
  app.post('/tasks/:id/job-notes', async (request, reply) => {
    const params = taskParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply
        .code(400)
        .send({ error: 'invalid task id', issues: params.error.issues });
    }
    const body = createBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply
        .code(400)
        .send({ error: 'invalid body', issues: body.error.issues });
    }
    const taskId = params.data.id;
    const tasks = await deps.db
      .select({
        id: applicationTasks.id,
        jobSpec: applicationTasks.jobSpec,
      })
      .from(applicationTasks)
      .where(eq(applicationTasks.id, taskId))
      .limit(1);
    const task = tasks[0];
    if (!task) {
      return reply.code(404).send({ error: 'task not found' });
    }
    const questionId = body.data.questionId;
    if (questionId !== undefined) {
      const known = (task.jobSpec?.questions ?? []).some(
        (q) => q.id === questionId,
      );
      if (!known) {
        return reply.code(400).send({
          error: `questionId '${questionId}' is not a question of this task`,
        });
      }
    }
    const inserted = await deps.db
      .insert(jobNotes)
      .values({
        taskId,
        body: body.data.body,
        questionId: questionId ?? null,
      })
      .returning();
    const note = inserted[0];
    if (!note) {
      return reply.code(500).send({ error: 'failed to record note' });
    }
    const sync = await mirrorTaskScratchpad(deps, taskId);
    return reply.code(200).send({ note, sync });
  });

  // Update a note in place (the dashboard's debounced autosave). Same
  // guarantees as create: a non-null questionId must name one of THIS task's
  // jobSpec questions, and the scratchpad is re-mirrored after the write.
  app.post('/tasks/:id/job-notes/:noteId', async (request, reply) => {
    const params = noteParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply
        .code(400)
        .send({ error: 'invalid id', issues: params.error.issues });
    }
    const body = updateBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply
        .code(400)
        .send({ error: 'invalid body', issues: body.error.issues });
    }
    const { id: taskId, noteId } = params.data;
    const tasks = await deps.db
      .select({
        id: applicationTasks.id,
        jobSpec: applicationTasks.jobSpec,
      })
      .from(applicationTasks)
      .where(eq(applicationTasks.id, taskId))
      .limit(1);
    const task = tasks[0];
    if (!task) {
      return reply.code(404).send({ error: 'task not found' });
    }
    const questionId = body.data.questionId;
    if (typeof questionId === 'string') {
      const known = (task.jobSpec?.questions ?? []).some(
        (q) => q.id === questionId,
      );
      if (!known) {
        return reply.code(400).send({
          error: `questionId '${questionId}' is not a question of this task`,
        });
      }
    }
    const updated = await deps.db
      .update(jobNotes)
      .set({
        ...(body.data.body !== undefined ? { body: body.data.body } : {}),
        ...(questionId !== undefined ? { questionId } : {}),
      })
      .where(and(eq(jobNotes.id, noteId), eq(jobNotes.taskId, taskId)))
      .returning();
    const note = updated[0];
    if (!note) {
      return reply.code(404).send({ error: 'note not found' });
    }
    const sync = await mirrorTaskScratchpad(deps, taskId);
    return reply.code(200).send({ note, sync });
  });

  // Delete a note and re-mirror the file WITHOUT it. An empty notes list
  // still writes (an empty file) — the path is never deleted, so the mirror
  // always reflects the DB.
  app.post('/tasks/:id/job-notes/:noteId/delete', async (request, reply) => {
    const params = noteParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply
        .code(400)
        .send({ error: 'invalid id', issues: params.error.issues });
    }
    const { id: taskId, noteId } = params.data;
    const tasks = await deps.db
      .select({ id: applicationTasks.id })
      .from(applicationTasks)
      .where(eq(applicationTasks.id, taskId))
      .limit(1);
    if (!tasks[0]) {
      return reply.code(404).send({ error: 'task not found' });
    }
    const deleted = await deps.db
      .delete(jobNotes)
      .where(and(eq(jobNotes.id, noteId), eq(jobNotes.taskId, taskId)))
      .returning({ id: jobNotes.id });
    if (!deleted[0]) {
      return reply.code(404).send({ error: 'note not found' });
    }
    const sync = await mirrorTaskScratchpad(deps, taskId);
    return reply.code(200).send({ ok: true, sync });
  });
}
