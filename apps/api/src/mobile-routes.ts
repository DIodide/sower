import {
  FOLLOWUP_KIND_LABELS,
  FOLLOWUP_STATE_LABELS,
  type FollowupKind,
  type FollowupState,
  type JobSpec,
  OPEN_FOLLOWUP_STATES,
  type Question,
  type ResolutionResult,
  type ResolvedAnswer,
  TASK_PRIORITY_LABELS,
  type TaskPriority,
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
import type { Deps } from './types.js';

/**
 * Compact READ-ONLY endpoints for the native iPhone app — the dashboard
 * reads the DB directly, a phone cannot. Zero writes; x-api-key via the
 * server-wide preHandler like every other route. The shapes stay in
 * lock-step with the dashboard pages they mirror:
 * - identity fallback: jobs row → jobSpec → URL host (lib/format rowLabel),
 *   returned as separate company/title pieces, never a pre-joined label
 * - effective deadline: the user's due_date wins over jobs.deadline
 *   (lib/deadline pickDeadline — the home page rows' precedence)
 * - the waiting list reads through waitingOrderBy (rank.ts), exactly the
 *   dashboard's "Waiting on you" order
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

/** Timeline entries returned by the task detail — newest first. */
const TIMELINE_CAP = 20;

const idParamsSchema = z.object({
  id: z.string().uuid(),
});

interface TaskCard {
  id: string;
  company: string | null;
  title: string | null;
  state: TaskState;
  priority: TaskPriority;
  priorityLabel: string;
  dueDate: string | null;
  url: string | null;
  openFollowups: number;
}

interface FollowupCard {
  id: string;
  taskId: string;
  kind: FollowupKind;
  kindLabel: string;
  title: string;
  state: FollowupState;
  stateLabel: string;
  dueDate: string | null;
  company: string | null;
}

/** ISO string for a (possibly invalid) stored date; invalid = absent. */
function isoOrNull(value: Date | null | undefined): string | null {
  if (!value || Number.isNaN(value.getTime())) {
    return null;
  }
  return value.toISOString();
}

/** Hostname (www. stripped) — the identity of last resort. */
function urlHost(url: string | null): string | null {
  if (!url) {
    return null;
  }
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

/**
 * The dashboard's rowLabel fallback (jobs row → jobSpec → URL host), kept as
 * separate pieces: the client composes its own label.
 */
function taskIdentity(row: {
  company: string | null;
  title: string | null;
  jobSpec: JobSpec | null;
  url: string | null;
}): { company: string | null; title: string | null } {
  const company = row.company || row.jobSpec?.company || null;
  const title = row.title || row.jobSpec?.title || null;
  if (company || title) {
    return { company, title };
  }
  return { company: urlHost(row.url), title: null };
}

/** The columns a TaskCard is built from (task + joined job). */
const cardSelection = {
  id: applicationTasks.id,
  state: applicationTasks.state,
  priority: applicationTasks.priority,
  dueDate: applicationTasks.dueDate,
  jobSpec: applicationTasks.jobSpec,
  company: jobs.company,
  title: jobs.title,
  url: jobs.url,
  deadline: jobs.deadline,
};

interface CardRow {
  id: string;
  state: TaskState;
  priority: TaskPriority;
  dueDate: Date | null;
  jobSpec: JobSpec | null;
  company: string | null;
  title: string | null;
  url: string | null;
  deadline: Date | null;
}

function taskCard(row: CardRow, openByTask: Map<string, number>): TaskCard {
  const identity = taskIdentity(row);
  return {
    id: row.id,
    company: identity.company,
    title: identity.title,
    state: row.state,
    priority: row.priority,
    priorityLabel: TASK_PRIORITY_LABELS[row.priority],
    // The user's own due date wins over the posting's parsed deadline —
    // the home page rows' pickDeadline precedence.
    dueDate: isoOrNull(row.dueDate) ?? isoOrNull(row.deadline),
    url: row.url,
    openFollowups: openByTask.get(row.id) ?? 0,
  };
}

interface FollowupRow {
  id: string;
  taskId: string;
  kind: FollowupKind;
  title: string;
  state: FollowupState;
  dueDate: Date | null;
  company: string | null;
  jobSpec: JobSpec | null;
}

function followupCard(row: FollowupRow): FollowupCard {
  return {
    id: row.id,
    taskId: row.taskId,
    kind: row.kind,
    kindLabel: FOLLOWUP_KIND_LABELS[row.kind],
    title: row.title,
    state: row.state,
    stateLabel: FOLLOWUP_STATE_LABELS[row.state],
    dueDate: isoOrNull(row.dueDate),
    // Same fallback the home page's "In play" rows render.
    company: row.company || row.jobSpec?.company || null,
  };
}

/**
 * A resolved answer as display text — the minimal mirror of the dashboard
 * questions panel: document paths become filenames, select values their
 * option labels, arrays join, and anything non-string degrades to compact
 * JSON rather than "[object Object]".
 */
function renderAnswerValue(
  question: Question,
  answer: ResolvedAnswer,
  filenameByPath: Map<string, string>,
): string | null {
  if (answer.value === null) {
    return null;
  }
  const raw = Array.isArray(answer.value) ? answer.value : [answer.value];
  const parts = raw.map((value) => {
    if (typeof value !== 'string') {
      return JSON.stringify(value);
    }
    if (answer.source === 'document') {
      return filenameByPath.get(value) ?? value;
    }
    if (question.type === 'select' || question.type === 'multiselect') {
      const option = (question.options ?? []).find(
        (o) => String(o.value) === value,
      );
      return option?.label ?? value;
    }
    return value;
  });
  return parts.join(', ');
}

interface QuestionSummary {
  id: string;
  label: string;
  type: Question['type'];
  required: boolean;
  status: 'resolved' | 'missing' | 'unresolved';
  value: string | null;
  source: string | null;
}

function buildQuestions(
  spec: JobSpec | null,
  resolution: ResolutionResult | null,
  filenameByPath: Map<string, string>,
): QuestionSummary[] {
  if (!spec) {
    return [];
  }
  const resolvedById = new Map(
    (resolution?.resolved ?? []).map((answer) => [answer.questionId, answer]),
  );
  const missingIds = new Set((resolution?.missing ?? []).map((q) => q.id));
  return spec.questions.map((question) => {
    const base = {
      id: question.id,
      label: question.label,
      type: question.type,
      required: question.required,
    };
    const answer = resolvedById.get(question.id);
    if (answer) {
      return {
        ...base,
        status: 'resolved' as const,
        value: renderAnswerValue(question, answer, filenameByPath),
        source: answer.source,
      };
    }
    return {
      ...base,
      status:
        resolution && missingIds.has(question.id)
          ? ('missing' as const)
          : ('unresolved' as const),
      value: null,
      source: null,
    };
  });
}

/**
 * One short human line per timeline event: the type prettified plus the few
 * data fields worth a glance (question/resolution counts, a note).
 */
function eventSummary(type: string, data: unknown): string {
  const words = type.toLowerCase().replace(/_/g, ' ');
  const label = words.charAt(0).toUpperCase() + words.slice(1);
  const record =
    data && typeof data === 'object' && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : undefined;
  const extras: string[] = [];
  if (typeof record?.questionCount === 'number') {
    extras.push(
      `${record.questionCount} question${record.questionCount === 1 ? '' : 's'}`,
    );
  }
  if (
    typeof record?.resolved === 'number' &&
    typeof record?.missing === 'number'
  ) {
    extras.push(`${record.resolved} resolved, ${record.missing} missing`);
  }
  if (typeof record?.note === 'string' && record.note !== '') {
    extras.push(record.note);
  }
  return extras.length > 0 ? `${label} — ${extras.join(' · ')}` : label;
}

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
    const identity = taskIdentity({
      company: row.job.company,
      title: row.job.title,
      jobSpec: row.task.jobSpec,
      url: row.job.url,
    });
    const company = row.job.company || row.task.jobSpec?.company || null;
    return {
      task: {
        id: row.task.id,
        state: row.task.state,
        priority: row.task.priority,
        priorityLabel: TASK_PRIORITY_LABELS[row.task.priority],
        dueDate: isoOrNull(row.task.dueDate) ?? isoOrNull(row.job.deadline),
        notes: row.task.notes,
        url: row.job.url,
        company: identity.company,
        title: identity.title,
        createdAt: isoOrNull(row.task.createdAt),
        updatedAt: isoOrNull(row.task.updatedAt),
      },
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
