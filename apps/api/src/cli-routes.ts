import type { BankEntry, BankValue } from '@sower/answers';
import {
  type FollowupKind,
  type FollowupState,
  type JobSpec,
  OPEN_FOLLOWUP_STATES,
  type ResolutionResult,
  TASK_PRIORITY_LABELS,
  type TaskPriority,
  type TaskState,
} from '@sower/core';
import {
  answers,
  applicationTasks,
  documents,
  events,
  followups,
  jobDescriptions,
  jobNotes,
  jobs,
} from '@sower/db';
import { asc, count, desc, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  buildQuestions,
  type DocumentInfo,
  eventSummary,
  type FollowupCard,
  followupCard,
  isoOrNull,
  TIMELINE_CAP,
  taskDetailView,
  taskIdentity,
} from './task-views.js';
import type { Deps } from './types.js';

/**
 * READ-ONLY endpoints for the sower CLI (apps/cli) — agents drive the
 * pipeline through the CLI without DB access. Zero writes; x-api-key via
 * the server-wide preHandler (which accepts either INGEST_API_KEY or the
 * CLI's own CLI_API_KEY). Row shaping is shared with the /mobile routes
 * (task-views.ts); the task detail here is the mobile detail PLUS the
 * pieces an agent needs that a phone screen omits: job-notes, follow-up
 * bodies (sourceBody), and the answer-bank 'saved' question status the
 * dashboard derives.
 */

/** All task states, for validating `?state=` (kept next to TaskState). */
const TASK_STATES = [
  'INGESTED',
  'PARSED',
  'QUEUED',
  'PREPARING',
  'NEEDS_INPUT',
  'REVIEW',
  'AWAITING_OTP',
  'FILLING',
  'SUBMITTED',
  'CONFIRMED',
  'FAILED',
  'DUPLICATE',
  'DISCARDED',
] as const satisfies readonly TaskState[];

const TASK_STATE_SET = new Set<string>(TASK_STATES);

/** The list's default page — a personal pipeline fits comfortably. */
const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 2000;

const idParamsSchema = z.object({
  id: z.string().uuid(),
});

const listQuerySchema = z.object({
  state: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
});

const exportQuerySchema = z.object({
  state: z.string().optional(),
});

/**
 * Parse `?state=` (comma list) into task states. null = no filter: ALL
 * states, archive included — the CLI's default view is the whole pipeline.
 */
function parseStateFilter(
  raw: string | undefined,
): { states: TaskState[] | null } | { invalid: string } {
  if (raw === undefined) {
    return { states: null };
  }
  const parts = raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '');
  if (parts.length === 0) {
    return { states: null };
  }
  for (const part of parts) {
    if (!TASK_STATE_SET.has(part)) {
      return { invalid: part };
    }
  }
  return { states: parts as TaskState[] };
}

/** The columns a CLI list row is built from (task + joined job). */
const listSelection = {
  id: applicationTasks.id,
  state: applicationTasks.state,
  priority: applicationTasks.priority,
  dueDate: applicationTasks.dueDate,
  jobSpec: applicationTasks.jobSpec,
  notes: applicationTasks.notes,
  createdAt: applicationTasks.createdAt,
  updatedAt: applicationTasks.updatedAt,
  company: jobs.company,
  title: jobs.title,
  url: jobs.url,
  platform: jobs.platform,
  source: jobs.source,
  deadline: jobs.deadline,
};

interface ListRow {
  id: string;
  state: TaskState;
  priority: TaskPriority;
  dueDate: Date | null;
  jobSpec: JobSpec | null;
  notes: string | null;
  createdAt: Date | null;
  updatedAt: Date | null;
  company: string | null;
  title: string | null;
  url: string | null;
  platform: string;
  source: string;
  deadline: Date | null;
}

function taskListItem(row: ListRow, openByTask: Map<string, number>) {
  const identity = taskIdentity(row);
  return {
    id: row.id,
    company: identity.company,
    title: identity.title,
    state: row.state,
    priority: row.priority,
    priorityLabel: TASK_PRIORITY_LABELS[row.priority],
    // Effective deadline: the user's own due date wins over the posting's
    // parsed deadline (the home page rows' pickDeadline precedence).
    dueDate: isoOrNull(row.dueDate) ?? isoOrNull(row.deadline),
    url: row.url,
    platform: row.platform,
    source: row.source,
    notes: row.notes,
    createdAt: isoOrNull(row.createdAt),
    updatedAt: isoOrNull(row.updatedAt),
    // Defensive ?? []: jsonb specs written before questions existed (or a
    // spec-as-identity stub) may lack the array entirely.
    questionCount: (row.jobSpec?.questions ?? []).length,
    openFollowups: openByTask.get(row.id) ?? 0,
  };
}

/** What the detail composer needs per task — all rows prefetched. */
interface DetailRows {
  task: {
    id: string;
    state: TaskState;
    priority: TaskPriority;
    dueDate: Date | null;
    notes: string | null;
    jobSpec: JobSpec | null;
    resolution: ResolutionResult | null;
    createdAt: Date | null;
    updatedAt: Date | null;
  };
  job: {
    company: string | null;
    title: string | null;
    url: string | null;
    deadline: Date | null;
  };
  description: string | null;
  followups: FollowupDetailRow[];
  events: EventRow[];
  notes: JobNoteRow[];
}

interface FollowupDetailRow {
  id: string;
  taskId: string;
  kind: FollowupKind;
  title: string;
  state: FollowupState;
  dueDate: Date | null;
  url: string | null;
  notes: string | null;
  sourceBody: string | null;
}

interface EventRow {
  type: string;
  createdAt: Date | null;
  data: unknown;
}

interface JobNoteRow {
  id: string;
  body: string;
  questionId: string | null;
  createdAt: Date | null;
}

interface DocumentRow extends DocumentInfo {
  storagePath: string;
}

/** The CLI follow-up: the mobile card plus url/notes/sourceBody in full. */
type CliFollowup = FollowupCard & {
  url: string | null;
  notes: string | null;
  sourceBody: string | null;
};

/**
 * Compose one task's full detail from prefetched rows — shared verbatim by
 * GET /cli/tasks/:id (per-task fetches) and GET /cli/export (batched
 * fetches), so the export's entries ARE the detail shape.
 */
function buildTaskDetail(
  rows: DetailRows,
  documentRows: DocumentRow[],
  bank: BankEntry[],
) {
  const filenameByPath = new Map(
    documentRows.map((doc) => [doc.storagePath, doc.filename]),
  );
  const docByPath = new Map<string, DocumentInfo>(
    documentRows.map((doc) => [
      doc.storagePath,
      { id: doc.id, kind: doc.kind, filename: doc.filename },
    ]),
  );
  const spec = rows.task.jobSpec ?? null;
  const company = rows.job.company || spec?.company || null;
  const cliFollowups: CliFollowup[] = rows.followups.map((followup) => ({
    ...followupCard({
      id: followup.id,
      taskId: followup.taskId,
      kind: followup.kind,
      title: followup.title,
      state: followup.state,
      dueDate: followup.dueDate,
      company,
      jobSpec: spec,
    }),
    url: followup.url,
    notes: followup.notes,
    // Stored as sanitized plain text (schema contract) — text only, and at
    // stored size: this is a personal DB, the CLI gets the whole thing.
    sourceBody: followup.sourceBody,
  }));
  return {
    task: taskDetailView(rows.task, rows.job),
    description: rows.description,
    questions: buildQuestions(
      spec,
      rows.task.resolution ?? null,
      filenameByPath,
      {
        // The dashboard's same bank read + company scoping, so 'saved'
        // statuses here preview exactly what the resolver will fill.
        bank,
        company: company ?? undefined,
        docByPath,
      },
    ),
    followups: cliFollowups,
    jobNotes: rows.notes.map((note) => ({
      id: note.id,
      body: note.body,
      questionId: note.questionId,
      questionLabel:
        note.questionId !== null
          ? ((spec?.questions ?? []).find((q) => q.id === note.questionId)
              ?.label ?? null)
          : null,
      createdAt: isoOrNull(note.createdAt),
    })),
    timeline: rows.events.map((event) => ({
      type: event.type,
      at: isoOrNull(event.createdAt),
      summary: eventSummary(event.type, event.data),
    })),
  };
}

/** The answers-bank read shared by detail and export (whole small table). */
function bankEntries(
  rows: { normalizedLabel: string; value: unknown; company: string }[],
): BankEntry[] {
  return rows.map((row) => ({
    normalizedLabel: row.normalizedLabel,
    value: row.value as BankValue,
    company: row.company,
  }));
}

export function registerCliRoutes(app: FastifyInstance, deps: Deps): void {
  // The pipeline in one list: ALL states by default (archive included),
  // newest activity first — an agent filters with `?state=` when it wants
  // a slice.
  app.get('/cli/tasks', async (request, reply) => {
    const query = listQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply
        .code(400)
        .send({ error: 'invalid query', issues: query.error.issues });
    }
    const filter = parseStateFilter(query.data.state);
    if ('invalid' in filter) {
      return reply.code(400).send({
        error: `invalid state '${filter.invalid}'`,
        allowed: TASK_STATES,
      });
    }
    const rows = await deps.db
      .select(listSelection)
      .from(applicationTasks)
      .innerJoin(jobs, eq(applicationTasks.jobId, jobs.id))
      .where(
        filter.states !== null
          ? inArray(applicationTasks.state, filter.states)
          : undefined,
      )
      .orderBy(desc(applicationTasks.updatedAt))
      .limit(query.data.limit);
    // Open follow-ups per task in ONE grouped query — never per row.
    const openRows = await deps.db
      .select({ taskId: followups.taskId, n: count() })
      .from(followups)
      .where(inArray(followups.state, [...OPEN_FOLLOWUP_STATES]))
      .groupBy(followups.taskId);
    const openByTask = new Map(openRows.map((row) => [row.taskId, row.n]));
    return { tasks: rows.map((row) => taskListItem(row, openByTask)) };
  });

  // Task detail: the mobile detail plus jobNotes, follow-up bodies, and
  // the answers-bank 'saved' question status.
  app.get('/cli/tasks/:id', async (request, reply) => {
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
    // The whole (small, personal) documents table — the dashboard's same
    // read: resolved doc answers show filenames, saved picks need id+kind.
    const documentRows = await deps.db
      .select({
        id: documents.id,
        kind: documents.kind,
        filename: documents.filename,
        storagePath: documents.storagePath,
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
        url: followups.url,
        notes: followups.notes,
        sourceBody: followups.sourceBody,
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
    // Oldest first — the same order the dashboard panel and the portfolio
    // scratchpad mirror render notes in.
    const noteRows = await deps.db
      .select({
        id: jobNotes.id,
        body: jobNotes.body,
        questionId: jobNotes.questionId,
        createdAt: jobNotes.createdAt,
      })
      .from(jobNotes)
      .where(eq(jobNotes.taskId, taskId))
      .orderBy(asc(jobNotes.createdAt));
    // The whole answers bank (small, personal — the dashboard's same read)
    // for the 'saved' question status.
    const bankRows = await deps.db
      .select({
        normalizedLabel: answers.normalizedLabel,
        value: answers.value,
        company: answers.company,
      })
      .from(answers);

    return buildTaskDetail(
      {
        task: row.task,
        job: row.job,
        description: descriptionRows[0]?.content ?? null,
        followups: followupRows,
        events: eventRows,
        notes: noteRows,
      },
      documentRows,
      bankEntries(bankRows),
    );
  });

  // Everything, once: the full detail shape for EVERY task (optionally
  // state-filtered). Seven whole-table/batched queries regardless of task
  // count — NEVER a per-task fetch. Description/sourceBody are returned at
  // stored size: this is a personal DB, the archive is the point.
  app.get('/cli/export', async (request, reply) => {
    const query = exportQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply
        .code(400)
        .send({ error: 'invalid query', issues: query.error.issues });
    }
    const filter = parseStateFilter(query.data.state);
    if ('invalid' in filter) {
      return reply.code(400).send({
        error: `invalid state '${filter.invalid}'`,
        allowed: TASK_STATES,
      });
    }
    const taskRows = await deps.db
      .select({ task: applicationTasks, job: jobs })
      .from(applicationTasks)
      .innerJoin(jobs, eq(applicationTasks.jobId, jobs.id))
      .where(
        filter.states !== null
          ? inArray(applicationTasks.state, filter.states)
          : undefined,
      )
      .orderBy(desc(applicationTasks.updatedAt));
    // Version desc globally: within a job the FIRST row seen is its latest
    // version, so keep-first-per-job yields exactly the current content.
    const descriptionRows = await deps.db
      .select({
        jobId: jobDescriptions.jobId,
        content: jobDescriptions.content,
      })
      .from(jobDescriptions)
      .orderBy(desc(jobDescriptions.version));
    const documentRows = await deps.db
      .select({
        id: documents.id,
        kind: documents.kind,
        filename: documents.filename,
        storagePath: documents.storagePath,
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
        url: followups.url,
        notes: followups.notes,
        sourceBody: followups.sourceBody,
      })
      .from(followups)
      .orderBy(desc(followups.createdAt));
    const eventRows = await deps.db
      .select({
        taskId: events.taskId,
        type: events.type,
        createdAt: events.createdAt,
        data: events.data,
      })
      .from(events)
      .orderBy(desc(events.createdAt));
    const noteRows = await deps.db
      .select({
        taskId: jobNotes.taskId,
        id: jobNotes.id,
        body: jobNotes.body,
        questionId: jobNotes.questionId,
        createdAt: jobNotes.createdAt,
      })
      .from(jobNotes)
      .orderBy(asc(jobNotes.createdAt));
    const bankRows = await deps.db
      .select({
        normalizedLabel: answers.normalizedLabel,
        value: answers.value,
        company: answers.company,
      })
      .from(answers);

    const descriptionByJob = new Map<string, string>();
    for (const row of descriptionRows) {
      if (!descriptionByJob.has(row.jobId)) {
        descriptionByJob.set(row.jobId, row.content);
      }
    }
    const followupsByTask = new Map<string, FollowupDetailRow[]>();
    for (const row of followupRows) {
      const list = followupsByTask.get(row.taskId) ?? [];
      list.push(row);
      followupsByTask.set(row.taskId, list);
    }
    // Rows are globally newest-first, so per task the first TIMELINE_CAP
    // seen are exactly the detail route's timeline.
    const eventsByTask = new Map<string, EventRow[]>();
    for (const row of eventRows) {
      const list = eventsByTask.get(row.taskId) ?? [];
      if (list.length < TIMELINE_CAP) {
        list.push(row);
        eventsByTask.set(row.taskId, list);
      }
    }
    const notesByTask = new Map<string, JobNoteRow[]>();
    for (const row of noteRows) {
      const list = notesByTask.get(row.taskId) ?? [];
      list.push(row);
      notesByTask.set(row.taskId, list);
    }
    const bank = bankEntries(bankRows);

    return {
      generatedAt: new Date().toISOString(),
      tasks: taskRows.map((row) =>
        buildTaskDetail(
          {
            task: row.task,
            job: row.job,
            description: descriptionByJob.get(row.task.jobId) ?? null,
            followups: followupsByTask.get(row.task.id) ?? [],
            events: eventsByTask.get(row.task.id) ?? [],
            notes: notesByTask.get(row.task.id) ?? [],
          },
          documentRows,
          bank,
        ),
      ),
    };
  });
}
