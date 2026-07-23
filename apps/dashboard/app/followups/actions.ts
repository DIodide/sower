'use server';

// Server actions for post-application follow-ups (assessments, interviews,
// recruiter threads, offers, rejections). Same shape as the task actions:
// zod-validate every input here, then call OUR api service (API_BASE_URL,
// x-api-key auth) — nothing talks to any external platform.

import type { FollowupEvent, FollowupKind } from '@sower/core';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import type { ActionResult } from '../tasks/[id]/actions';

const uuidSchema = z.string().uuid();

const kindSchema = z.enum([
  'assessment',
  'interview',
  'recruiter',
  'offer',
  'rejection',
  'other',
]);
const eventSchema = z.enum([
  'TRIAGE',
  'SCHEDULE',
  'COMPLETE_STEP',
  'RESOLVE',
  'DISMISS',
  'REOPEN',
]);

const titleSchema = z.string().trim().min(1).max(300);
// Https-only, mirroring the api's rule: the detail page renders this as an
// "Open <host>" button, so a javascript:/relative/plain-http value must
// never be stored.
const urlSchema = z
  .string()
  .trim()
  .max(2000)
  .refine(
    (value) => {
      try {
        return new URL(value).protocol === 'https:';
      } catch {
        return false;
      }
    },
    { message: 'url must be a valid https link' },
  );
const notesSchema = z.string().max(20_000);
// Same acceptance as the task due date: full ISO datetime or bare
// yyyy-mm-dd (date-only = all-day, ET semantics — the api interprets it).
const dueDateSchema = z
  .string()
  .trim()
  .max(64)
  .refine((value) => !Number.isNaN(Date.parse(value)), {
    message: 'dueDate must be a parseable ISO date',
  });

const createSchema = z.object({
  kind: kindSchema,
  title: titleSchema,
  url: urlSchema.optional(),
  notes: notesSchema.optional(),
  dueDate: dueDateSchema.optional(),
});

// PATCH semantics mirror the task meta action: only provided fields change,
// null clears, and at least one field must be present.
const patchSchema = z
  .object({
    title: titleSchema.optional(),
    url: urlSchema.nullable().optional(),
    notes: notesSchema.nullable().optional(),
    dueDate: dueDateSchema.nullable().optional(),
  })
  .refine(
    (patch) =>
      patch.title !== undefined ||
      patch.url !== undefined ||
      patch.notes !== undefined ||
      patch.dueDate !== undefined,
    { message: 'provide at least one of title, url, notes, dueDate' },
  );

/**
 * Create a follow-up on a task via the api service. Revalidates the task
 * page (the Post-application panel lists it) and the home list ("In play").
 */
export async function createFollowup(
  taskId: string,
  input: {
    kind: FollowupKind;
    title: string;
    url?: string;
    notes?: string;
    dueDate?: string;
  },
): Promise<ActionResult> {
  const idParse = uuidSchema.safeParse(taskId);
  if (!idParse.success) return { ok: false, message: 'invalid task id.' };
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      message: parsed.error.issues[0]?.message ?? 'invalid follow-up.',
    };
  }
  const result = await callFollowupApi(
    `/tasks/${idParse.data}/followups`,
    'POST',
    parsed.data,
  );
  if (!result.ok) {
    return { ok: false, message: `add follow-up failed: ${result.message}` };
  }
  revalidatePath(`/tasks/${idParse.data}`);
  revalidatePath('/');
  return { ok: true, message: 'follow-up added.' };
}

/**
 * Update a follow-up's user-editable fields via the api service. PATCH
 * semantics: only the provided fields change (url/notes/dueDate: null
 * clears). Like the task meta action, only the detail page and the home
 * list are revalidated.
 */
export async function patchFollowup(
  followupId: string,
  patch: {
    title?: string;
    url?: string | null;
    notes?: string | null;
    dueDate?: string | null;
  },
): Promise<ActionResult> {
  const idParse = uuidSchema.safeParse(followupId);
  if (!idParse.success) return { ok: false, message: 'invalid follow-up id.' };
  const parsed = patchSchema.safeParse(patch);
  if (!parsed.success) {
    return {
      ok: false,
      message: parsed.error.issues[0]?.message ?? 'nothing to update.',
    };
  }
  const result = await callFollowupApi(
    `/followups/${idParse.data}`,
    'PATCH',
    parsed.data,
  );
  if (!result.ok) {
    return { ok: false, message: `save failed: ${result.message}` };
  }
  revalidatePath(`/followups/${idParse.data}`);
  revalidatePath('/');
  return { ok: true, message: 'saved.' };
}

/** Bound-argument shim for the shared InlineNote editor (`saveAction`). */
export async function saveFollowupNotes(
  followupId: string,
  notes: string | null,
): Promise<ActionResult> {
  return patchFollowup(followupId, { notes });
}

/** Bound-argument shim for the shared DueDateControl (`saveAction`). */
export async function saveFollowupDueDate(
  followupId: string,
  dueDate: string | null,
): Promise<ActionResult> {
  return patchFollowup(followupId, { dueDate });
}

/** Per-event success wording — destinations in plain words, never enums. */
const TRANSITION_MESSAGES: Record<FollowupEvent, string> = {
  TRIAGE: 'marked as needing your action.',
  SCHEDULE: 'marked scheduled.',
  COMPLETE_STEP: 'step completed — now waiting on them.',
  RESOLVE: 'done — this follow-up is resolved.',
  DISMISS: 'dismissed.',
  REOPEN: 'reopened — back to needing your action.',
};

/**
 * Advance a follow-up through its state machine via the api service. A 409
 * means the transition is no longer valid from the current state (e.g. two
 * tabs raced) — reported as such, never as a generic failure. `taskId`, when
 * known, additionally revalidates the parent task's panel.
 */
export async function transitionFollowup(
  followupId: string,
  event: FollowupEvent,
  taskId?: string,
): Promise<ActionResult> {
  const idParse = uuidSchema.safeParse(followupId);
  if (!idParse.success) return { ok: false, message: 'invalid follow-up id.' };
  const eventParse = eventSchema.safeParse(event);
  if (!eventParse.success) {
    return { ok: false, message: 'invalid follow-up event.' };
  }
  const result = await callFollowupApi(
    `/followups/${idParse.data}/transition`,
    'POST',
    { event: eventParse.data },
  );
  if (!result.ok) {
    if (result.status === 409) {
      return {
        ok: false,
        message:
          'that step is no longer allowed — the follow-up has already moved on. Refresh to see its current state.',
      };
    }
    return { ok: false, message: `${event} failed: ${result.message}` };
  }
  revalidatePath(`/followups/${idParse.data}`);
  if (taskId && uuidSchema.safeParse(taskId).success) {
    revalidatePath(`/tasks/${taskId}`);
  }
  revalidatePath('/');
  return { ok: true, message: TRANSITION_MESSAGES[eventParse.data] };
}

/**
 * Move a follow-up to a different application via the api service. Both the
 * old and new tasks' panels change; the detail page, the target task page,
 * and the home list are revalidated (the client refreshes for the rest).
 */
export async function reassignFollowup(
  followupId: string,
  taskId: string,
): Promise<ActionResult> {
  const idParse = uuidSchema.safeParse(followupId);
  if (!idParse.success) return { ok: false, message: 'invalid follow-up id.' };
  const taskParse = uuidSchema.safeParse(taskId);
  if (!taskParse.success) return { ok: false, message: 'invalid task id.' };
  const result = await callFollowupApi(
    `/followups/${idParse.data}/reassign`,
    'POST',
    { taskId: taskParse.data },
  );
  if (!result.ok) {
    if (result.status === 404) {
      return {
        ok: false,
        message:
          'that application no longer exists — refresh and pick another.',
      };
    }
    return { ok: false, message: `move failed: ${result.message}` };
  }
  revalidatePath(`/followups/${idParse.data}`);
  revalidatePath(`/tasks/${taskParse.data}`);
  revalidatePath('/');
  return { ok: true, message: 'moved to the selected application.' };
}

const apiResponseSchema = z.object({
  followup: z.unknown().optional(),
  error: z.string().optional(),
  message: z.string().optional(),
});

/**
 * Call the sower api service (and ONLY the sower api service — the base URL
 * comes from our own deployment env, never from user input or job data).
 * Mirrors the task actions' callApi: status-based error normalization, the
 * api's own error string when it sent one.
 */
async function callFollowupApi(
  path: string,
  method: 'POST' | 'PATCH',
  jsonBody: Record<string, unknown>,
): Promise<{ ok: boolean; status: number; message: string }> {
  const base = process.env.API_BASE_URL;
  const apiKey = process.env.INGEST_API_KEY;
  if (!base || !apiKey) {
    return {
      ok: false,
      status: 0,
      message:
        'api service is not configured (API_BASE_URL / INGEST_API_KEY missing).',
    };
  }

  let response: Response;
  try {
    response = await fetch(`${base.replace(/\/$/, '')}${path}`, {
      method,
      headers: {
        'x-api-key': apiKey,
        'content-type': 'application/json',
      },
      body: JSON.stringify(jsonBody),
      cache: 'no-store',
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    return {
      ok: false,
      status: 0,
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
      status: response.status,
      message: `(${response.status}) ${body.error ?? body.message ?? 'see api logs'}`,
    };
  }
  return { ok: true, status: response.status, message: '' };
}
