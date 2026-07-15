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
import { normalizeLabel } from '@sower/answers';
import type { Question } from '@sower/core';
import { answers, applicationTasks, documents, jobs } from '@sower/db';
import { createStorage } from '@sower/storage';
import { eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { getDb } from '../../../lib/db';
import { documentKind } from './question-kind';

export interface ActionResult {
  ok: boolean;
  message: string;
}

const uuidSchema = z.string().uuid();
const textAnswerSchema = z.string().trim().min(1).max(20_000);

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

function optionValueSet(question: Question): Set<string> {
  return new Set((question.options ?? []).map((o) => String(o.value)));
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
  value: string | string[],
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
        const allowed = optionValueSet(question);
        const invalid = raw.filter((v) => !allowed.has(v));
        if (invalid.length > 0) {
          errors.push(
            `"${question.label}": value not among the question's options`,
          );
          continue;
        }
        await upsertAnswer(db, question, raw, '');
        savedCount += 1;
        continue;
      }

      const raw = formData.get(`q:${question.id}`);
      if (typeof raw !== 'string' || raw === '') continue;

      if (question.type === 'select') {
        if (!optionValueSet(question).has(raw)) {
          errors.push(
            `"${question.label}": value not among the question's options`,
          );
          continue;
        }
        await upsertAnswer(db, question, raw, '');
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
    message = `${message ? `${message}; ` : ''}${requeue.message}`;
    ok = requeue.ok;
  } else if (errors.length > 0) {
    message = `${message ? `${message}; ` : ''}errors: ${errors.join('; ')}`;
  }

  revalidatePath(`/tasks/${idParse.data}`);
  return { ok, message: message || 'saved.' };
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
  error: z.string().optional(),
  message: z.string().optional(),
});

/**
 * Call the sower api service (and ONLY the sower api service — the base URL
 * comes from our own deployment env, never from user input or job data).
 */
async function callApi(
  taskId: string,
  action: 'requeue' | 'approve' | 'otp' | 'start' | 'verify-form',
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
    const back = ` task is back in ${body.state ?? 'REVIEW'}.`;
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

  if (action === 'otp') {
    if (body.skipped) {
      return {
        ok: true,
        message: 'code not applied — the task is no longer waiting on a code.',
      };
    }
    return {
      ok: true,
      message: `code accepted; task resumed (state: ${body.state ?? 'FILLING'}).`,
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
    message: `task requeued (state: ${body.state ?? 'QUEUED'}).`,
  };
}
