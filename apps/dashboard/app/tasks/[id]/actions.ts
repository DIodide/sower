'use server';

// Server actions for the task detail view. The dashboard surface is
// IAP-protected; these actions additionally validate every input with zod
// and only accept question ids present in the task's own job_spec.
//
// SAFETY: nothing here talks to any external job platform directly. Requeue/
// approve go through OUR api service (API_BASE_URL, x-api-key auth). On the api
// side, approve is a dry-run for greenhouse/lever/ashby (payload built and
// recorded, never sent) and, for Workday, a real calypso fill that STOPS
// before finalize — it never submits (finalize is separately gated).

import { randomUUID } from 'node:crypto';
import {
  type AnswerInput,
  documentKind,
  saveAnswersToBank,
} from '@sower/answers';
import type { Question, TaskPriority } from '@sower/core';
import { applicationTasks, documents, fillJobs, jobs } from '@sower/db';
import { createStorage } from '@sower/storage';
import { eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { getDb } from '../../../lib/db';
import { SECTIONS } from '../../../lib/format';

export interface ActionResult {
  ok: boolean;
  message: string;
}

const uuidSchema = z.string().uuid();

// PATCH-style task meta (notes/priority/dueDate) — mirrors the api's
// /tasks/:id/meta contract: only provided fields are written, notes/dueDate:
// null clears, and at least one field must be present.
const taskPrioritySchema = z.union([
  z.literal(-1),
  z.literal(0),
  z.literal(1),
  z.literal(2),
]);
const taskDueDateSchema = z
  .string()
  .trim()
  .max(64)
  .refine((value) => !Number.isNaN(Date.parse(value)), {
    message: 'dueDate must be a parseable ISO date',
  });
const taskMetaSchema = z
  .object({
    notes: z.string().max(20_000).nullable().optional(),
    priority: taskPrioritySchema.optional(),
    dueDate: taskDueDateSchema.nullable().optional(),
  })
  .refine(
    (meta) =>
      meta.notes !== undefined ||
      meta.priority !== undefined ||
      meta.dueDate !== undefined,
    { message: 'provide at least one of notes, priority, dueDate' },
  );

// Reorder within "Waiting on you": the row's new neighbors (beforeTaskId
// immediately above, afterTaskId immediately below); the api computes the
// rank. At least one must be present (both absent would mean "nowhere").
const reorderNeighborsSchema = z
  .object({
    beforeTaskId: z.string().uuid().optional(),
    afterTaskId: z.string().uuid().optional(),
  })
  .refine(
    (neighbors) =>
      neighbors.beforeTaskId !== undefined ||
      neighbors.afterTaskId !== undefined,
    { message: 'provide at least one neighbor' },
  );

const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

function sanitizeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const cleaned = base
    .replace(/[^\w.\- ]+/g, '_')
    .trim()
    .slice(0, 120);
  if (cleaned === '' || cleaned === '.' || cleaned === '..') return 'file';
  return cleaned;
}

/**
 * Store a freshly uploaded file as a documents row of the question's kind
 * and return its id — the bank then binds the question to THIS document
 * (not merely the first document of the kind) through the shared writer,
 * exactly like an existing-document pick.
 */
async function storeUpload(
  db: ReturnType<typeof getDb>,
  question: Question,
  upload: File,
): Promise<string> {
  const kind = documentKind(question);
  const filename = sanitizeFilename(upload.name);
  const storagePath = `documents/${randomUUID()}/${filename}`;
  const data = Buffer.from(await upload.arrayBuffer());
  await createStorage().put(storagePath, data, upload.type || undefined);
  const inserted = await db
    .insert(documents)
    .values({
      kind,
      filename,
      storagePath,
      contentType: upload.type || null,
      sizeBytes: upload.size,
    })
    .returning({ id: documents.id });
  const row = inserted[0];
  if (!row) throw new Error('failed to record the uploaded document');
  return row.id;
}

/**
 * Persist user-provided answers for a task's missing questions.
 *
 * The form is read here (field names, uploads); the bank semantics — which
 * question ids are writable, option validation, company vs global scope,
 * document-kind checks, the 20k cap, source 'user' — live in ONE place,
 * @sower/answers saveAnswersToBank, shared with the api's
 * POST /tasks/:id/answers so the two surfaces can never drift.
 *
 * Scoping: text/textarea (essay) answers are saved COMPANY-SCOPED to this
 * task's company by default — they only auto-fill future applications at the
 * same company. The per-question "reuse for all companies" checkbox
 * (`global:<id>`) saves them globally instead. Select/multiselect/file
 * answers are always global. When the task has no company, everything is
 * saved globally.
 *
 * When formData carries intent=save_requeue the task is also requeued via
 * the api service.
 */
export async function saveAnswers(
  taskId: string,
  formData: FormData,
): Promise<ActionResult> {
  const idParse = uuidSchema.safeParse(taskId);
  if (!idParse.success) {
    return { ok: false, message: 'invalid task id.' };
  }

  let db: ReturnType<typeof getDb>;
  try {
    db = getDb();
  } catch {
    return { ok: false, message: 'database is not configured (DATABASE_URL).' };
  }

  const taskRows = await db
    .select({
      id: applicationTasks.id,
      jobSpec: applicationTasks.jobSpec,
      jobCompany: jobs.company,
    })
    .from(applicationTasks)
    .leftJoin(jobs, eq(applicationTasks.jobId, jobs.id))
    .where(eq(applicationTasks.id, idParse.data))
    .limit(1);
  const task = taskRows[0];
  if (!task) {
    return { ok: false, message: 'task not found.' };
  }
  if (!task.jobSpec) {
    return {
      ok: false,
      message: 'this task has no job spec yet, so there is nothing to answer.',
    };
  }

  const errors: string[] = [];
  const inputs: AnswerInput[] = [];
  // Questions whose document was uploaded in THIS submit (the receipt
  // counts them as uploads, not plain saves).
  const uploaded = new Set<string>();

  // ONLY iterate the task's own job_spec questions — any other form field is
  // ignored, so arbitrary question ids can never be written.
  for (const question of task.jobSpec.questions) {
    if (question.type === 'file') {
      const upload = formData.get(`file:${question.id}`);
      if (upload instanceof File && upload.size > 0) {
        if (upload.size > MAX_UPLOAD_BYTES) {
          errors.push(`"${question.label}": file exceeds 15 MB limit`);
          continue;
        }
        try {
          inputs.push({
            questionId: question.id,
            value: await storeUpload(db, question, upload),
            scope:
              formData.get(`global:${question.id}`) === '1'
                ? 'global'
                : 'company',
          });
          uploaded.add(question.id);
        } catch (err) {
          errors.push(
            `"${question.label}": ${err instanceof Error ? err.message : 'failed to save'}`,
          );
        }
        continue;
      }
      // An existing document was picked: the shared writer validates the
      // reference (exists, right kind) and binds it to this question.
      const docId = formData.get(`doc:${question.id}`);
      if (typeof docId === 'string' && docId !== '') {
        inputs.push({
          questionId: question.id,
          value: docId,
          scope:
            formData.get(`global:${question.id}`) === '1'
              ? 'global'
              : 'company',
        });
      }
      continue;
    }

    if (question.type === 'multiselect') {
      const raw = formData
        .getAll(`q:${question.id}`)
        .filter((v): v is string => typeof v === 'string' && v !== '');
      if (raw.length > 0) {
        inputs.push({ questionId: question.id, value: raw });
      }
      continue;
    }

    const raw = formData.get(`q:${question.id}`);
    if (typeof raw !== 'string' || raw === '') continue;
    if (question.type === 'select') {
      inputs.push({ questionId: question.id, value: raw });
      continue;
    }
    // text / textarea — company-scoped by default; the "reuse for all
    // companies" checkbox saves it globally instead.
    inputs.push({
      questionId: question.id,
      value: raw,
      scope:
        formData.get(`global:${question.id}`) === '1' ? 'global' : 'company',
    });
  }

  const outcome = await saveAnswersToBank(db, {
    questions: task.jobSpec.questions,
    company: task.jobCompany ?? task.jobSpec.company,
    answers: inputs,
  });
  for (const error of outcome.errors) {
    errors.push(`"${error.label ?? error.questionId}": ${error.message}`);
  }
  const uploadedCount = outcome.saved.filter((id) => uploaded.has(id)).length;
  const savedCount = outcome.saved.length - uploadedCount;

  const parts: string[] = [];
  if (savedCount > 0)
    parts.push(`saved ${savedCount} answer${savedCount === 1 ? '' : 's'}`);
  if (uploadedCount > 0) {
    parts.push(
      `uploaded ${uploadedCount} document${uploadedCount === 1 ? '' : 's'}`,
    );
  }
  if (parts.length === 0 && errors.length === 0) {
    return {
      ok: false,
      message: 'nothing to save — fill in at least one field.',
    };
  }

  let ok = errors.length === 0;
  let message = parts.join(', ');

  if (formData.get('intent') === 'save_requeue') {
    if (errors.length > 0) {
      ok = false;
      message = `${message ? `${message}; ` : ''}not requeued because some fields failed: ${errors.join('; ')}`;
      revalidatePath(`/tasks/${idParse.data}`);
      return { ok, message };
    }
    const requeue = await callApi(idParse.data, 'requeue');
    ok = requeue.ok;
    // 'requeue skipped' is ok:true but the task will NOT re-run — surface the
    // api's own explanation instead of promising a run that won't happen.
    const rerunning =
      requeue.ok && !requeue.message.startsWith('requeue skipped');
    message = rerunning
      ? `${message} — re-running the application with your answers…`
      : `${message ? `${message}; ` : ''}${requeue.message}`;
  } else if (errors.length > 0) {
    message = `${message ? `${message}; ` : ''}errors: ${errors.join('; ')}`;
  } else {
    // Plain save: the page re-renders with the saved answers shown under
    // "Saved for the next run", so say exactly where they went.
    message = `${message} to your answer library — shown below; applies on the next run.`;
  }

  revalidatePath(`/tasks/${idParse.data}`);
  return { ok, message: message || 'saved.' };
}

/**
 * Update a task's user-facing metadata (notes, priority, and/or the user's
 * own due date) via the api service. PATCH semantics: only the provided
 * fields change (notes/dueDate: null clears). Only the task page is
 * revalidated — deliberately NOT the home list: the row owns its optimistic
 * note/priority/due-date state, and a list revalidation mid-edit would
 * re-sort rows under the user's hands. Order settles on the next natural
 * refresh. Note the api side: an actual priority change CLEARS the row's
 * manual rank (ranks only order rows within a tier) — the row re-enters its
 * new tier as its newest unranked item, i.e. at the TOP of that tier, and
 * can never demote below it.
 */
export async function updateTaskMeta(
  taskId: string,
  meta: {
    notes?: string | null;
    priority?: TaskPriority;
    dueDate?: string | null;
  },
): Promise<ActionResult> {
  const idParse = uuidSchema.safeParse(taskId);
  if (!idParse.success) return { ok: false, message: 'invalid task id.' };
  const metaParse = taskMetaSchema.safeParse(meta);
  if (!metaParse.success) {
    if (typeof meta.notes === 'string' && meta.notes.length > 20_000) {
      return {
        ok: false,
        message: 'note is too long (max 20,000 characters).',
      };
    }
    if (
      typeof meta.dueDate === 'string' &&
      Number.isNaN(Date.parse(meta.dueDate))
    ) {
      return { ok: false, message: 'not a valid date.' };
    }
    return {
      ok: false,
      message: 'nothing to update — provide notes, a priority, or a due date.',
    };
  }
  const result = await callApi(idParse.data, 'meta', metaParse.data);
  revalidatePath(`/tasks/${idParse.data}`);
  return result;
}

/**
 * Move a "Waiting on you" row to a new manual position via the api service:
 * the client reports the row's new NEIGHBORS, the api derives the
 * destination tier from them (a drop across a tier boundary adopts that
 * tier's priority — priority and rank land in one atomic update, and the
 * response carries {priority} when it changed) and computes the sort rank
 * within the tier (midpoint / end-gap, per-tier resequencing when needed).
 * The OrderedList mirrors the tier rule (lib/reorder dropPriority) for its
 * optimistic priority chip and the "Moved to High" toast. Deliberately no
 * list revalidation: the OrderedList owns the optimistic order and
 * refreshes explicitly once the write lands.
 */
export async function reorderTask(
  taskId: string,
  neighbors: { beforeTaskId?: string; afterTaskId?: string },
): Promise<ActionResult> {
  const idParse = uuidSchema.safeParse(taskId);
  if (!idParse.success) return { ok: false, message: 'invalid task id.' };
  const neighborsParse = reorderNeighborsSchema.safeParse(neighbors);
  if (!neighborsParse.success) {
    return { ok: false, message: 'invalid drop position.' };
  }
  return callApi(idParse.data, 'reorder', neighborsParse.data);
}

/** Requeue a NEEDS_INPUT / FAILED task via the api service. */
export async function requeueTask(taskId: string): Promise<ActionResult> {
  const idParse = uuidSchema.safeParse(taskId);
  if (!idParse.success) return { ok: false, message: 'invalid task id.' };
  const result = await callApi(idParse.data, 'requeue');
  revalidatePath(`/tasks/${idParse.data}`);
  return result;
}

/**
 * Approve a REVIEW task via the api service. The api performs a DRY-RUN
 * submit only: it constructs and records the payload, performs zero network
 * I/O toward the platform, and returns the task to REVIEW.
 */
export async function approveTask(taskId: string): Promise<ActionResult> {
  const idParse = uuidSchema.safeParse(taskId);
  if (!idParse.success) return { ok: false, message: 'invalid task id.' };
  const result = await callApi(idParse.data, 'approve');
  revalidatePath(`/tasks/${idParse.data}`);
  return result;
}

/**
 * Request a headful Workday session capture for a parked task's tenant. The api
 * provisions the candidate account and flags the request; the local capture
 * agent (on the user's machine) opens the browser. Workday-only on the api side.
 */
export async function startSessionCapture(
  taskId: string,
): Promise<ActionResult> {
  const idParse = uuidSchema.safeParse(taskId);
  if (!idParse.success) return { ok: false, message: 'invalid task id.' };
  const result = await callApi(idParse.data, 'start');
  revalidatePath(`/tasks/${idParse.data}`);
  return result;
}

/**
 * Human confirmation of an agent-discovered form via the api service: marks
 * jobSpec.formVerified, records a FORM_VERIFIED event, and edits the Discord
 * #ingest reply to the verified line. Idempotent on the api side.
 */
export async function verifyDiscoveredForm(
  taskId: string,
): Promise<ActionResult> {
  const idParse = uuidSchema.safeParse(taskId);
  if (!idParse.success) return { ok: false, message: 'invalid task id.' };
  const result = await callApi(idParse.data, 'verify-form');
  revalidatePath(`/tasks/${idParse.data}`);
  return result;
}

/**
 * Discard a task via the api service: a human removes it from the queue
 * (terminal DISCARDED state; refused for SUBMITTED/CONFIRMED). An optional
 * short note ("why") travels with it and is stored on the DISCARD event —
 * absent or blank means exactly the note-less discard the rows use.
 * Revalidates the task page plus the queue and home lists the row
 * disappears from.
 */
export async function discardTask(
  taskId: string,
  note?: string,
): Promise<ActionResult> {
  const idParse = uuidSchema.safeParse(taskId);
  if (!idParse.success) return { ok: false, message: 'invalid task id.' };
  const trimmed = typeof note === 'string' ? note.trim() : '';
  if (trimmed.length > 2000) {
    return {
      ok: false,
      message: 'discard note is too long (max 2,000 characters).',
    };
  }
  const result = await callApi(
    idParse.data,
    'discard',
    trimmed === '' ? undefined : { note: trimmed },
  );
  revalidatePath(`/tasks/${idParse.data}`);
  revalidatePath('/');
  return result;
}

/**
 * Mark a task applied out of band via the api service: the human completed
 * the application themselves, so the task jumps straight to SUBMITTED
 * (refused for DISCARDED/DUPLICATE; already-sent tasks are a no-op). An
 * optional short note ("where/how") travels with it and is stored on the
 * MARK_SUBMITTED event. Revalidates the task page plus the home list the
 * row moves within.
 */
export async function markApplied(
  taskId: string,
  note?: string,
): Promise<ActionResult> {
  const idParse = uuidSchema.safeParse(taskId);
  if (!idParse.success) return { ok: false, message: 'invalid task id.' };
  const trimmed = typeof note === 'string' ? note.trim() : '';
  if (trimmed.length > 2000) {
    return {
      ok: false,
      message: 'note is too long (max 2,000 characters).',
    };
  }
  const result = await callApi(
    idParse.data,
    'mark-applied',
    trimmed === '' ? undefined : { note: trimmed },
  );
  revalidatePath(`/tasks/${idParse.data}`);
  revalidatePath('/');
  return result;
}

/**
 * Un-mark a task that was mistakenly "Marked applied" via the api service.
 * Allowed ONLY when the task is SUBMITTED via an out-of-band MARK_SUBMITTED —
 * an application sower actually submitted (SUBMIT_OK) is refused with a 409.
 * Lands back in NEEDS_INPUT, like Restore. Revalidates the task page plus
 * the home list the row moves within.
 */
export async function unmarkApplied(taskId: string): Promise<ActionResult> {
  const idParse = uuidSchema.safeParse(taskId);
  if (!idParse.success) return { ok: false, message: 'invalid task id.' };
  const result = await callApi(idParse.data, 'unmark-applied');
  revalidatePath(`/tasks/${idParse.data}`);
  revalidatePath('/');
  return result;
}

/**
 * Restore a DISCARDED task via the api service (the Archive's Restore and the
 * discard toast's Undo). Lands back in NEEDS_INPUT; restoring a task that is
 * already NEEDS_INPUT is a no-op on the api side, so a double-clicked undo
 * never errors.
 */
export async function restoreTask(taskId: string): Promise<ActionResult> {
  const idParse = uuidSchema.safeParse(taskId);
  if (!idParse.success) return { ok: false, message: 'invalid task id.' };
  const result = await callApi(idParse.data, 'restore');
  revalidatePath(`/tasks/${idParse.data}`);
  revalidatePath('/');
  return result;
}

/**
 * Re-ingest a task via the api service: the SAME task (same id) is reset in
 * place back to INGESTED — pipeline artifacts (attempt, last error, job spec,
 * resolution) cleared, user annotations kept — and re-run through today's
 * ingest pipeline (fresh parse, current probes/adapters). Refused by the api
 * (409) for SUBMITTED/CONFIRMED.
 */
export async function reingestTask(taskId: string): Promise<ActionResult> {
  const idParse = uuidSchema.safeParse(taskId);
  if (!idParse.success) return { ok: false, message: 'invalid task id.' };
  const result = await callApi(idParse.data, 'reingest');
  revalidatePath(`/tasks/${idParse.data}`);
  revalidatePath('/');
  return result;
}

/**
 * Manually start the browser agent (form-discovery investigation) on an
 * unsupported maybe-job via the api service. The api gates eligibility
 * (unknown platform or a recorded screenshot) and reports whether the agent
 * actually fired (it self-gates on SCREENSHOT_INVESTIGATION_ENABLED).
 */
export async function investigateTask(taskId: string): Promise<ActionResult> {
  const idParse = uuidSchema.safeParse(taskId);
  if (!idParse.success) return { ok: false, message: 'invalid task id.' };
  const result = await callApi(idParse.data, 'investigate');
  revalidatePath(`/tasks/${idParse.data}`);
  revalidatePath('/');
  return result;
}

/**
 * Ask the api to queue a "fill in browser" job for a greenhouse task
 * (POST /tasks/:id/fill). The runner on the user's machine claims it, opens
 * the real form in a browser via OpenTab, and fills the answered questions —
 * it NEVER submits; the human finishes in the live view. The api enforces
 * eligibility (greenhouse, NEEDS_INPUT/REVIEW) and refuses a second job
 * while one is still active.
 */
export async function requestBrowserFill(
  taskId: string,
): Promise<ActionResult> {
  const idParse = uuidSchema.safeParse(taskId);
  if (!idParse.success) return { ok: false, message: 'invalid task id.' };
  const result = await callApi(idParse.data, 'fill');
  revalidatePath(`/tasks/${idParse.data}`);
  return result;
}

/** One fill job's poll snapshot: the status plus change markers, so the
 *  FillJobRefresher refreshes the page only when the panel would change. */
export interface FillJobStatusResult {
  ok: boolean;
  message: string;
  job?: { status: string; hasLiveView: boolean; hasReport: boolean };
}

/** The FillJobRefresher's 2s poll — reads the row directly, like the page. */
export async function getFillJobStatus(
  jobId: string,
): Promise<FillJobStatusResult> {
  const idParse = uuidSchema.safeParse(jobId);
  if (!idParse.success) return { ok: false, message: 'invalid fill job id.' };
  let db: ReturnType<typeof getDb>;
  try {
    db = getDb();
  } catch {
    return { ok: false, message: 'database is not configured (DATABASE_URL).' };
  }
  const rows = await db
    .select({
      status: fillJobs.status,
      liveViewUrl: fillJobs.liveViewUrl,
      report: fillJobs.report,
    })
    .from(fillJobs)
    .where(eq(fillJobs.id, idParse.data))
    .limit(1);
  const job = rows[0];
  if (!job) return { ok: false, message: 'fill job not found.' };
  return {
    ok: true,
    message: job.status,
    job: {
      status: job.status,
      hasLiveView: job.liveViewUrl !== null,
      hasReport: job.report !== null,
    },
  };
}

/** A job-note action's result: the mirror outcome rides along so the panel
 *  can quietly surface a skipped/failed GitHub push (the note itself always
 *  landed — the DB is the source of truth). */
export interface JobNoteActionResult extends ActionResult {
  /** 'mirrored' | 'skipped: no token' | 'failed: …' from the api. */
  sync?: string;
  /** Create only: the new row's id, so the client-side panel can reconcile
   *  its optimistic note (and route follow-up edits at the real row). */
  noteId?: string;
}

// Mirrors the api's create body: 20k cap like every other user text, and a
// questionId the api validates against the task's own jobSpec questions.
const jobNoteCreateSchema = z.object({
  body: z.string().trim().min(1).max(20_000),
  questionId: z.string().max(200).optional(),
});

/**
 * Add a job note via the api service. The api inserts the row and re-mirrors
 * the portfolio scratchpad; a GitHub failure never fails the request (the
 * outcome arrives as `sync`).
 */
export async function createJobNote(
  taskId: string,
  input: { body: string; questionId?: string },
): Promise<JobNoteActionResult> {
  const idParse = uuidSchema.safeParse(taskId);
  if (!idParse.success) return { ok: false, message: 'invalid task id.' };
  const parsed = jobNoteCreateSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      message:
        input.body.trim() === ''
          ? 'write the note first.'
          : 'note is too long (max 20,000 characters).',
    };
  }
  const result = await callJobNotesApi(
    `/tasks/${idParse.data}/job-notes`,
    parsed.data,
  );
  if (!result.ok) {
    return { ok: false, message: `add note failed: ${result.message}` };
  }
  revalidatePath(`/tasks/${idParse.data}`);
  const created = z.object({ id: z.string() }).safeParse(result.note);
  return {
    ok: true,
    message: 'note added.',
    sync: result.sync,
    ...(created.success ? { noteId: created.data.id } : {}),
  };
}

// Mirrors the api's update body: PATCH semantics — only provided fields
// change, questionId null clears the tie, at least one field required.
const jobNoteUpdateSchema = z
  .object({
    body: z.string().trim().min(1).max(20_000).optional(),
    questionId: z.string().max(200).nullable().optional(),
  })
  .refine(
    (patch) => patch.body !== undefined || patch.questionId !== undefined,
    { message: 'provide at least one of body, questionId' },
  );

/**
 * Update a job note in place via the api service (the panel's debounced
 * autosave). The api validates a non-null questionId against the task's own
 * jobSpec and re-mirrors the scratchpad after the write.
 */
export async function updateJobNote(
  taskId: string,
  noteId: string,
  patch: { body?: string; questionId?: string | null },
): Promise<JobNoteActionResult> {
  const idParse = uuidSchema.safeParse(taskId);
  if (!idParse.success) return { ok: false, message: 'invalid task id.' };
  const noteParse = uuidSchema.safeParse(noteId);
  if (!noteParse.success) return { ok: false, message: 'invalid note id.' };
  const parsed = jobNoteUpdateSchema.safeParse(patch);
  if (!parsed.success) {
    return {
      ok: false,
      message:
        typeof patch.body === 'string' && patch.body.length > 20_000
          ? 'note is too long (max 20,000 characters).'
          : typeof patch.body === 'string' && patch.body.trim() === ''
            ? 'write the note first.'
            : 'nothing to update.',
    };
  }
  const result = await callJobNotesApi(
    `/tasks/${idParse.data}/job-notes/${noteParse.data}`,
    parsed.data,
  );
  if (!result.ok) {
    return { ok: false, message: `save failed: ${result.message}` };
  }
  revalidatePath(`/tasks/${idParse.data}`);
  return { ok: true, message: 'saved.', sync: result.sync };
}

/**
 * Delete a job note via the api service; the scratchpad is regenerated
 * WITHOUT it (an empty list still writes an empty file).
 */
export async function deleteJobNote(
  taskId: string,
  noteId: string,
): Promise<JobNoteActionResult> {
  const idParse = uuidSchema.safeParse(taskId);
  if (!idParse.success) return { ok: false, message: 'invalid task id.' };
  const noteParse = uuidSchema.safeParse(noteId);
  if (!noteParse.success) return { ok: false, message: 'invalid note id.' };
  const result = await callJobNotesApi(
    `/tasks/${idParse.data}/job-notes/${noteParse.data}/delete`,
  );
  if (!result.ok) {
    return { ok: false, message: `delete failed: ${result.message}` };
  }
  revalidatePath(`/tasks/${idParse.data}`);
  return { ok: true, message: 'note deleted.', sync: result.sync };
}

/**
 * Deliver a one-time code to an AWAITING_OTP task via the api service, which
 * stores it and resumes the task (AWAITING_OTP -> FILLING). Mirrors the
 * Discord modal path; either can satisfy the same wait.
 */
export async function submitOtp(
  taskId: string,
  code: string,
): Promise<ActionResult> {
  const idParse = uuidSchema.safeParse(taskId);
  if (!idParse.success) return { ok: false, message: 'invalid task id.' };
  const trimmed = code.trim();
  if (trimmed.length < 4) {
    return { ok: false, message: 'enter the code from the email.' };
  }
  const result = await callApi(idParse.data, 'otp', { code: trimmed });
  revalidatePath(`/tasks/${idParse.data}`);
  return result;
}

const jobNotesApiResponseSchema = z.object({
  note: z.unknown().optional(),
  ok: z.boolean().optional(),
  sync: z.string().optional(),
  error: z.string().optional(),
  message: z.string().optional(),
});

/**
 * Call the sower api service's job-notes routes (and ONLY the sower api
 * service — the base URL comes from our own deployment env, never from user
 * input or job data). Mirrors callApi; kept separate because these routes
 * answer the {note/ok, sync} shape rather than the task-action one. The raw
 * `note` rides along so createJobNote can pull the new row's id out of it.
 */
async function callJobNotesApi(
  path: string,
  jsonBody?: Record<string, unknown>,
): Promise<{ ok: boolean; message: string; sync?: string; note?: unknown }> {
  const base = process.env.API_BASE_URL;
  const apiKey = process.env.INGEST_API_KEY;
  if (!base || !apiKey) {
    return {
      ok: false,
      message:
        'api service is not configured (API_BASE_URL / INGEST_API_KEY missing).',
    };
  }

  let response: Response;
  try {
    response = await fetch(`${base.replace(/\/$/, '')}${path}`, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        ...(jsonBody ? { 'content-type': 'application/json' } : {}),
      },
      body: jsonBody ? JSON.stringify(jsonBody) : undefined,
      cache: 'no-store',
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    return {
      ok: false,
      message: `could not reach the api service: ${err instanceof Error ? err.message : 'unknown error'}`,
    };
  }

  let body: z.infer<typeof jobNotesApiResponseSchema> = {};
  try {
    body = jobNotesApiResponseSchema.parse(await response.json());
  } catch {
    // Non-JSON or unexpected shape: fall through to status-based messaging.
  }

  if (!response.ok) {
    return {
      ok: false,
      message: `(${response.status}) ${body.error ?? body.message ?? 'see api logs'}`,
    };
  }
  return { ok: true, message: '', sync: body.sync, note: body.note };
}

const apiResponseSchema = z.object({
  state: z.string().optional(),
  ok: z.boolean().optional(),
  fired: z.boolean().optional(),
  skipped: z.boolean().optional(),
  dryRun: z.boolean().optional(),
  mode: z.enum(['dry-run', 'workday-fill']).optional(),
  note: z.string().optional(),
  tenant: z.string().optional(),
  status: z.string().optional(),
  payloadSummary: z
    .object({
      fieldCount: z.number(),
      fileCount: z.number(),
    })
    .optional(),
  sortRank: z.number().optional(),
  /** Reorder only: present when the drop crossed a tier boundary and the
   *  row adopted the destination tier's priority. */
  priority: z.number().optional(),
  /** Fill only: the already-active job on a 409 (presence is the signal). */
  job: z.unknown().optional(),
  error: z.string().optional(),
  message: z.string().optional(),
});

/**
 * Call the sower api service (and ONLY the sower api service — the base URL
 * comes from our own deployment env, never from user input or job data).
 */
async function callApi(
  taskId: string,
  action:
    | 'requeue'
    | 'approve'
    | 'otp'
    | 'start'
    | 'verify-form'
    | 'discard'
    | 'restore'
    | 'mark-applied'
    | 'unmark-applied'
    | 'investigate'
    | 'meta'
    | 'reorder'
    | 'reingest'
    | 'fill',
  jsonBody?: Record<string, unknown>,
): Promise<ActionResult> {
  const base = process.env.API_BASE_URL;
  const apiKey = process.env.INGEST_API_KEY;
  if (!base || !apiKey) {
    return {
      ok: false,
      message:
        'api service is not configured (API_BASE_URL / INGEST_API_KEY missing).',
    };
  }

  let response: Response;
  try {
    response = await fetch(
      `${base.replace(/\/$/, '')}/tasks/${taskId}/${action}`,
      {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          ...(jsonBody ? { 'content-type': 'application/json' } : {}),
        },
        body: jsonBody ? JSON.stringify(jsonBody) : undefined,
        cache: 'no-store',
        signal: AbortSignal.timeout(30_000),
      },
    );
  } catch (err) {
    return {
      ok: false,
      message: `could not reach the api service: ${err instanceof Error ? err.message : 'unknown error'}`,
    };
  }

  let body: z.infer<typeof apiResponseSchema> = {};
  try {
    body = apiResponseSchema.parse(await response.json());
  } catch {
    // Non-JSON or unexpected shape: fall through to status-based messaging.
  }

  if (!response.ok) {
    // Fill's active-job 409 carries the existing job — a friendly nudge, not
    // an error dump: the Browser fill panel already shows that job live.
    if (
      action === 'fill' &&
      response.status === 409 &&
      body.job !== undefined
    ) {
      return {
        ok: false,
        message:
          'a browser fill is already in progress for this task — see the Browser fill panel.',
      };
    }
    return {
      ok: false,
      message: `${action} failed (${response.status}): ${body.error ?? body.message ?? 'see api logs'}`,
    };
  }

  if (action === 'approve') {
    // The api returns an honest per-mode summary (dry-run vs a real Workday
    // draft that stopped before submit). Prefer it; fall back for older apis.
    const back = ` The task stays in "${SECTIONS.waiting}" — ready for your review.`;
    if (body.note) {
      return { ok: true, message: `${body.note}${back}` };
    }
    const summary = body.payloadSummary
      ? ` — payload: ${body.payloadSummary.fieldCount} fields, ${body.payloadSummary.fileCount} files`
      : '';
    return {
      ok: true,
      message: `dry-run submit recorded${summary}; no real submission was made.${back}`,
    };
  }

  if (action === 'fill') {
    return {
      ok: true,
      message:
        'browser fill requested — the runner on your machine will open and fill the form; watch the Browser fill panel for the live view link.',
    };
  }

  if (action === 'start') {
    return {
      ok: true,
      message: `Session capture requested for ${body.tenant ?? 'this tenant'} — the local agent will open a browser on your machine; sign in there. Once the session is captured the task advances automatically.`,
    };
  }

  if (action === 'verify-form') {
    return {
      ok: true,
      message:
        'form verified — recorded on the task and the Discord ingest reply now shows it as verified.',
    };
  }

  if (action === 'discard') {
    return {
      ok: true,
      message: `task discarded — moved to the ${SECTIONS.archive} (record and history kept).`,
    };
  }

  if (action === 'restore') {
    return {
      ok: true,
      message: `task restored — back in "${SECTIONS.waiting}".`,
    };
  }

  if (action === 'reingest') {
    return {
      ok: true,
      message:
        're-ingested — this task was reset and is running through ingestion again from scratch.',
    };
  }

  if (action === 'mark-applied') {
    return {
      ok: true,
      message: `marked applied — moved to ${SECTIONS.sent}.`,
    };
  }

  if (action === 'unmark-applied') {
    return {
      ok: true,
      message: `un-marked — back in "${SECTIONS.waiting}".`,
    };
  }

  if (action === 'meta') {
    return { ok: true, message: 'saved.' };
  }

  if (action === 'reorder') {
    return { ok: true, message: 'order saved.' };
  }

  if (action === 'investigate') {
    return body.fired
      ? {
          ok: true,
          message:
            'browser agent started — it is discovering the application form now; results land on this task.',
        }
      : {
          ok: false,
          message:
            'the browser agent did not start — investigation is disabled on the api service (SCREENSHOT_INVESTIGATION_ENABLED).',
        };
  }

  if (action === 'otp') {
    if (body.skipped) {
      return {
        ok: true,
        message: 'code not applied — the task is no longer waiting on a code.',
      };
    }
    return {
      ok: true,
      message: `code accepted — moved to "${SECTIONS.processing}" while sower finishes the application.`,
    };
  }

  if (body.skipped) {
    return {
      ok: true,
      message:
        'requeue skipped — the task is no longer in a requeueable state.',
    };
  }
  return {
    ok: true,
    message: `task requeued — moved to "${SECTIONS.processing}" for another attempt.`,
  };
}
