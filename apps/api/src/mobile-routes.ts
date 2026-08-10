import {
  FOLLOWUP_KIND_LABELS,
  FOLLOWUP_STATE_LABELS,
  OPEN_FOLLOWUP_STATES,
  type TaskState,
} from '@sower/core';
import {
  applicationTasks,
  documents,
  events,
  followups,
  jobDescriptions,
  jobs,
} from '@sower/db';
import { count, desc, eq, inArray, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { waitingOrderBy } from './rank.js';
import {
  buildQuestions,
  cardSelection,
  eventSummary,
  followupCard,
  isoOrNull,
  TIMELINE_CAP,
  taskCard,
  taskDetailView,
  taskIdentity,
} from './task-views.js';
import type { Deps } from './types.js';

/**
 * Compact READ-ONLY endpoints for the native iPhone app — the dashboard
 * reads the DB directly, a phone cannot. Zero writes; x-api-key via the
 * server-wide preHandler like every other route. Row shaping (identity
 * fallback, effective deadline, question statuses, timeline summaries) is
 * shared with the /cli routes — see task-views.ts; the waiting list reads
 * through waitingOrderBy (rank.ts), exactly the dashboard's "Waiting on
 * you" order.
 */

/** The mobile overview's actionable list: NEEDS_INPUT + REVIEW. */
const WAITING_STATES: readonly TaskState[] = ['NEEDS_INPUT', 'REVIEW'];

const PROCESSING_STATES: readonly TaskState[] = [
  'INGESTED',
  'PARSED',
  'QUEUED',
  'PREPARING',
  'FILLING',
];

const SENT_STATES: readonly TaskState[] = ['SUBMITTED', 'CONFIRMED'];

/** Sent rows are history — cap them so the payload stays phone-sized. */
const SENT_CAP = 50;

const idParamsSchema = z.object({
  id: z.string().uuid(),
});

export function registerMobileRoutes(app: FastifyInstance, deps: Deps): void {
  // The home screen in one call: waiting (the dashboard's exact order),
  // a processing count, open follow-ups ("In play"), and recent sent.
  app.get('/mobile/overview', async () => {
    const waitingRows = await deps.db
      .select(cardSelection)
      .from(applicationTasks)
      .innerJoin(jobs, eq(applicationTasks.jobId, jobs.id))
      .where(inArray(applicationTasks.state, [...WAITING_STATES]))
      .orderBy(...waitingOrderBy());
    const processingCounts = await deps.db
      .select({ n: count() })
      .from(applicationTasks)
      .where(inArray(applicationTasks.state, [...PROCESSING_STATES]));
    const inPlayRows = await deps.db
      .select({
        id: followups.id,
        taskId: followups.taskId,
        kind: followups.kind,
        title: followups.title,
        state: followups.state,
        dueDate: followups.dueDate,
        company: jobs.company,
        jobSpec: applicationTasks.jobSpec,
      })
      .from(followups)
      .innerJoin(applicationTasks, eq(followups.taskId, applicationTasks.id))
      .innerJoin(jobs, eq(applicationTasks.jobId, jobs.id))
      .where(inArray(followups.state, [...OPEN_FOLLOWUP_STATES]))
      .orderBy(
        sql`${followups.dueDate} asc nulls last`,
        desc(followups.createdAt),
      );
    const sentRows = await deps.db
      .select(cardSelection)
      .from(applicationTasks)
      .innerJoin(jobs, eq(applicationTasks.jobId, jobs.id))
      .where(inArray(applicationTasks.state, [...SENT_STATES]))
      .orderBy(desc(applicationTasks.updatedAt))
      .limit(SENT_CAP);

    // Open follow-ups per task from the "In play" fetch itself, so a card's
    // count can never disagree with the section (the dashboard's pattern).
    const openByTask = new Map<string, number>();
    for (const row of inPlayRows) {
      openByTask.set(row.taskId, (openByTask.get(row.taskId) ?? 0) + 1);
    }
    return {
      waiting: waitingRows.map((row) => taskCard(row, openByTask)),
      processing: { count: processingCounts[0]?.n ?? 0 },
      inPlay: inPlayRows.map(followupCard),
      sent: sentRows.map((row) => taskCard(row, openByTask)),
    };
  });

  // Task detail: everything the phone's task screen shows in one call.
  app.get('/mobile/tasks/:id', async (request, reply) => {
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
    const descriptionRows = await deps.db
      .select({ content: jobDescriptions.content })
      .from(jobDescriptions)
      .where(eq(jobDescriptions.jobId, row.job.id))
      .orderBy(desc(jobDescriptions.version))
      .limit(1);
    // Document answers store storage paths; the phone shows filenames. The
    // whole (small, personal) documents table — the dashboard's same read.
    const documentRows = await deps.db
      .select({
        storagePath: documents.storagePath,
        filename: documents.filename,
      })
      .from(documents);
    const followupRows = await deps.db
      .select({
        id: followups.id,
        taskId: followups.taskId,
        kind: followups.kind,
        title: followups.title,
        state: followups.state,
        dueDate: followups.dueDate,
      })
      .from(followups)
      .where(eq(followups.taskId, taskId))
      .orderBy(desc(followups.createdAt));
    const eventRows = await deps.db
      .select({
        type: events.type,
        createdAt: events.createdAt,
        data: events.data,
      })
      .from(events)
      .where(eq(events.taskId, taskId))
      .orderBy(desc(events.createdAt))
      .limit(TIMELINE_CAP);

    const filenameByPath = new Map(
      documentRows.map((doc) => [doc.storagePath, doc.filename]),
    );
    const company = row.job.company || row.task.jobSpec?.company || null;
    return {
      task: taskDetailView(row.task, row.job),
      description: descriptionRows[0]?.content ?? null,
      questions: buildQuestions(
        row.task.jobSpec ?? null,
        row.task.resolution ?? null,
        filenameByPath,
      ),
      followups: followupRows.map((followup) =>
        followupCard({ ...followup, company, jobSpec: row.task.jobSpec }),
      ),
      timeline: eventRows.map((event) => ({
        type: event.type,
        at: isoOrNull(event.createdAt),
        summary: eventSummary(event.type, event.data),
      })),
    };
  });

  // Follow-up detail with the parent application's identity joined in.
  app.get('/mobile/followups/:id', async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply
        .code(400)
        .send({ error: 'invalid followup id', issues: params.error.issues });
    }
    const rows = await deps.db
      .select({
        followup: followups,
        taskId: applicationTasks.id,
        jobSpec: applicationTasks.jobSpec,
        company: jobs.company,
        title: jobs.title,
        url: jobs.url,
      })
      .from(followups)
      .innerJoin(applicationTasks, eq(followups.taskId, applicationTasks.id))
      .innerJoin(jobs, eq(applicationTasks.jobId, jobs.id))
      .where(eq(followups.id, params.data.id))
      .limit(1);
    const row = rows[0];
    if (!row) {
      return reply.code(404).send({ error: 'followup not found' });
    }
    const identity = taskIdentity(row);
    return {
      followup: {
        id: row.followup.id,
        taskId: row.followup.taskId,
        kind: row.followup.kind,
        kindLabel: FOLLOWUP_KIND_LABELS[row.followup.kind],
        title: row.followup.title,
        state: row.followup.state,
        stateLabel: FOLLOWUP_STATE_LABELS[row.followup.state],
        dueDate: isoOrNull(row.followup.dueDate),
        url: row.followup.url,
        notes: row.followup.notes,
        // Stored as sanitized plain text (schema contract) — text only.
        sourceBody: row.followup.sourceBody,
      },
      task: {
        id: row.taskId,
        company: identity.company,
        title: identity.title,
      },
    };
  });
}
