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
import type { BankValue } from '@sower/answers';
import { normalizeLabel } from '@sower/answers';
import type { Question, TaskPriority } from '@sower/core';
import { answers, applicationTasks, documents, jobs } from '@sower/db';
import { createStorage } from '@sower/storage';
import { eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { getDb } from '../../../lib/db';
import { SECTIONS } from '../../../lib/format';
import { documentKind } from './question-kind';

export interface ActionResult {
  ok: boolean;
  message: string;
}

const uuidSchema = z.string().uuid();
const textAnswerSchema = z.string().trim().min(1).max(20_000);

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

/** option value id -> human label, for validating and labeling select saves. */
function optionLabelByValue(question: Question): Map<string, string> {
  return new Map(
    (question.options ?? []).map((o) => [String(o.value), o.label]),
  );
}

/**
 * Upsert a bank answer keyed by (company, normalized label). `company` is a
 * normalized company key ('' = GLOBAL): a company-scoped save never touches
 * the global row and vice versa, so one company's essay answer can never
 * overwrite — or leak to — another company's.
 */
async function upsertAnswer(
  db: ReturnType<typeof getDb>,
  question: Question,
  value: BankValue,
  company: string,
): Promise<void> {
  const normalized = normalizeLabel(question.label);
  // A label that normalizes to '' (e.g. all punctuation) can't be a bank key —
  // it would collide with every other empty-label answer in the same scope.
  if (normalized === '') return;
  // Atomic upsert on the (company, normalized_label) unique index: a concurrent
  // double-save can't create two rows, and a company-scoped write never touches
  // the global row or another company's.
  await db
    .insert(answers)
    .values({
      questionLabel: question.label,
      normalizedLabel: normalized,
      value,
      source: 'user',
      company,
    })
    .onConflictDoUpdate({
      target: [answers.company, answers.normalizedLabel],
      set: { questionLabel: question.label, value, source: 'user' },
    });
}

async function handleFileQuestion(
  db: ReturnType<typeof getDb>,
  question: Question,
  formData: FormData,
  errors: string[],
): Promise<boolean> {
  const kind = documentKind(question);
  const upload = formData.get(`file:${question.id}`);

  if (upload instanceof File && upload.size > 0) {
    if (upload.size > MAX_UPLOAD_BYTES) {
      errors.push(`"${question.label}": file exceeds 15 MB limit`);
      return false;
    }
    const filename = sanitizeFilename(upload.name);
    const storagePath = `documents/${randomUUID()}/${filename}`;
    const data = Buffer.from(await upload.arrayBuffer());
    await createStorage().put(storagePath, data, upload.type || undefined);
    await db.insert(documents).values({
      kind,
      filename,
      storagePath,
      contentType: upload.type || null,
      sizeBytes: upload.size,
    });
    // Record the pick so resolution binds THIS question to THIS document
    // (not merely the first document of the kind). Document picks are global:
    // the same resume/cover letter is reusable across companies.
    await upsertAnswer(db, question, storagePath, '');
    return true;
  }

  // An existing document was picked: validate the reference and bind it to this
  // question so resolution honors the specific choice (previously a no-op that
  // silently discarded the selection).
  const docId = formData.get(`doc:${question.id}`);
  if (typeof docId === 'string' && docId !== '') {
    const parsed = uuidSchema.safeParse(docId);
    if (!parsed.success) {
      errors.push(`"${question.label}": invalid document reference`);
      return false;
    }
    const found = await db
      .select({
        id: documents.id,
        kind: documents.kind,
        storagePath: documents.storagePath,
      })
      .from(documents)
      .where(eq(documents.id, parsed.data))
      .limit(1);
    if (!found[0]) {
      errors.push(`"${question.label}": selected document no longer exists`);
      return false;
    }
    if (found[0].kind !== kind) {
      errors.push(
        `"${question.label}": selected document is kind "${found[0].kind}", expected "${kind}"`,
      );
      return false;
    }
    await upsertAnswer(db, question, found[0].storagePath, '');
    return true;
  }
  return false;
}

/**
 * Persist user-provided answers for a task's missing questions.
 *
 * Truthfulness: only explicit user input is stored (source 'user'); select
 * and multiselect values are rejected unless they exactly match one of the
 * question's option values. Question ids not present in this task's
 * job_spec are ignored entirely.
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

  // Normalized company key for scoping essay answers ('' when unknown) —
  // same normalization the resolver uses (see @sower/answers ResolveOptions).
  const companyKey = (task.jobCompany ?? task.jobSpec.company ?? '')
    .toLowerCase()
    .trim();

  const errors: string[] = [];
  let savedCount = 0;
  let uploadedCount = 0;

  // ONLY iterate the task's own job_spec questions — any other form field is
  // ignored, so arbitrary question ids can never be written.
  for (const question of task.jobSpec.questions) {
    try {
      if (question.type === 'file') {
        if (await handleFileQuestion(db, question, formData, errors)) {
          uploadedCount += 1;
        }
        continue;
      }

      if (question.type === 'multiselect') {
        const raw = formData
          .getAll(`q:${question.id}`)
          .filter((v): v is string => typeof v === 'string' && v !== '');
        if (raw.length === 0) continue;
        const labels = optionLabelByValue(question);
        const invalid = raw.filter((v) => !labels.has(v));
        if (invalid.length > 0) {
          errors.push(
            `"${question.label}": value not among the question's options`,
          );
          continue;
        }
        // Store {value,label} pairs: the label is what the answers page shows
        // and what lets the pick resolve on another company's form, where
        // option value ids differ (see @sower/answers matchStoredOption).
        await upsertAnswer(
          db,
          question,
          raw.map((v) => ({ value: v, label: labels.get(v) ?? v })),
          '',
        );
        savedCount += 1;
        continue;
      }

      const raw = formData.get(`q:${question.id}`);
      if (typeof raw !== 'string' || raw === '') continue;

      if (question.type === 'select') {
        const label = optionLabelByValue(question).get(raw);
        if (label === undefined) {
          errors.push(
            `"${question.label}": value not among the question's options`,
          );
          continue;
        }
        // {value,label}: human-readable in the library, resolvable by value
        // on this form and by label on any other tenant's variant of it.
        await upsertAnswer(db, question, { value: raw, label }, '');
        savedCount += 1;
        continue;
      }

      // text / textarea — company-scoped by default; the "reuse for all
      // companies" checkbox saves it globally instead.
      const parsed = textAnswerSchema.safeParse(raw);
      if (!parsed.success) {
        errors.push(
          `"${question.label}": ${parsed.error.issues[0]?.message ?? 'invalid value'}`,
        );
        continue;
      }
      const reuseEverywhere = formData.get(`global:${question.id}`) === '1';
      await upsertAnswer(
        db,
        question,
        parsed.data,
        reuseEverywhere ? '' : companyKey,
      );
      savedCount += 1;
    } catch (err) {
      errors.push(
        `"${question.label}": ${err instanceof Error ? err.message : 'failed to save'}`,
      );
    }
  }

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
    | 'reingest',
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
