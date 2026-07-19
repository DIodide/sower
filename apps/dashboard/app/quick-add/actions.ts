'use server';

// Server actions for the quick-add surface (Phase-2 UI): paste a blob of
// text/URLs into the ingest classifier, or record a URL-less job by hand.
//
// SAFETY: same posture as the task-detail actions — only OUR api service is
// called (API_BASE_URL from deployment env, x-api-key auth), never a job
// platform. The api reuses the Discord classifier for pastes (dedupe,
// directory expansion, unsupported parking, never-drop) with jobs.source
// stamped 'manual', and parks manual entries NEEDS_INPUT.

import type { TaskPriority } from '@sower/core';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import type { ActionResult } from '../tasks/[id]/actions';

const pasteTextSchema = z.string().min(1).max(10_000);

const taskPrioritySchema = z.union([z.literal(-1), z.literal(0), z.literal(1)]);
const manualAddSchema = z.object({
  company: z.string().trim().min(1).max(200),
  title: z.string().trim().min(1).max(300).optional(),
  notes: z.string().max(20_000).optional(),
  priority: taskPrioritySchema.optional(),
});

// What POST /ingest/paste reports back (outcomes are ignored here — the
// summary counts carry the user-facing message; Phase 2 can read outcomes
// directly from the endpoint if it grows a per-row result list).
const pasteResponseSchema = z.object({
  ok: z.boolean().optional(),
  urls: z.number(),
  ingested: z.number(),
  duplicates: z.number(),
  unsupported: z.number(),
  directories: z.number(),
  errors: z.number(),
});

const manualResponseSchema = z.object({
  ok: z.boolean().optional(),
  taskId: z.string().optional(),
  jobId: z.string().optional(),
});

const errorResponseSchema = z.object({
  error: z.string().optional(),
  message: z.string().optional(),
});

/**
 * POST a body to the sower api service (and ONLY the sower api service — the
 * base URL comes from our own deployment env, never from user input).
 * Returns the raw Response, or an ActionResult when the call could not be
 * made at all.
 */
async function postApi(
  path: string,
  body: Record<string, unknown>,
): Promise<Response | ActionResult> {
  const base = process.env.API_BASE_URL;
  const apiKey = process.env.INGEST_API_KEY;
  if (!base || !apiKey) {
    return {
      ok: false,
      message:
        'api service is not configured (API_BASE_URL / INGEST_API_KEY missing).',
    };
  }
  try {
    return await fetch(`${base.replace(/\/$/, '')}${path}`, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      cache: 'no-store',
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    return {
      ok: false,
      message: `could not reach the api service: ${err instanceof Error ? err.message : 'unknown error'}`,
    };
  }
}

async function failureMessage(
  what: string,
  response: Response,
): Promise<ActionResult> {
  let detail = 'see api logs';
  try {
    const parsed = errorResponseSchema.parse(await response.json());
    detail = parsed.error ?? parsed.message ?? detail;
  } catch {
    // Non-JSON body: keep the fallback.
  }
  return {
    ok: false,
    message: `${what} failed (${response.status}): ${detail}`,
  };
}

/**
 * Quick-add paste box: send a pasted text blob to POST /ingest/paste, which
 * runs the same classifier the Discord #ingest channel uses. Every URL gets
 * exactly one outcome (queued, parked, duplicate, expanded, or error) and the
 * message summarizes them; text with no URLs is a friendly no-op.
 */
export async function pasteIngest(text: string): Promise<ActionResult> {
  const parsed = pasteTextSchema.safeParse(text);
  if (!parsed.success) {
    return {
      ok: false,
      message: 'paste some text first (up to 10,000 characters).',
    };
  }

  const response = await postApi('/ingest/paste', { text: parsed.data });
  if (!(response instanceof Response)) return response;
  if (!response.ok) return failureMessage('paste ingest', response);

  let summary: z.infer<typeof pasteResponseSchema>;
  try {
    summary = pasteResponseSchema.parse(await response.json());
  } catch {
    return { ok: false, message: 'unexpected api response — see api logs.' };
  }

  revalidatePath('/');
  revalidatePath('/queue');

  if (summary.urls === 0) {
    return {
      ok: true,
      message:
        'no links found in the pasted text — for a job without a URL, use manual add.',
    };
  }
  const parts: string[] = [];
  if (summary.ingested > 0) parts.push(`${summary.ingested} queued`);
  if (summary.unsupported > 0) {
    parts.push(`${summary.unsupported} recorded (unsupported)`);
  }
  if (summary.duplicates > 0) {
    parts.push(`${summary.duplicates} already known`);
  }
  if (summary.directories > 0) {
    parts.push(
      `${summary.directories} director${summary.directories === 1 ? 'y' : 'ies'} expanded`,
    );
  }
  if (summary.errors > 0) parts.push(`${summary.errors} failed`);
  return {
    // Errors are reported, not swallowed — but partial success is success.
    ok: summary.errors < summary.urls,
    message: `${summary.urls} link${summary.urls === 1 ? '' : 's'} processed: ${parts.join(', ')}.`,
  };
}

/**
 * Manual entry for a job with NO url (recruiter conversation, career-fair
 * lead): POST /ingest/manual records it under a manual:// placeholder and
 * parks it NEEDS_INPUT — it needs the user — with notes/priority applied to
 * the new task in the same request.
 */
export async function manualAdd(input: {
  company: string;
  title?: string;
  notes?: string;
  priority?: TaskPriority;
}): Promise<ActionResult> {
  const parsed = manualAddSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      message: 'company is required (up to 200 characters).',
    };
  }

  const response = await postApi('/ingest/manual', parsed.data);
  if (!(response instanceof Response)) return response;
  if (!response.ok) return failureMessage('manual add', response);

  let result: z.infer<typeof manualResponseSchema>;
  try {
    result = manualResponseSchema.parse(await response.json());
  } catch {
    return { ok: false, message: 'unexpected api response — see api logs.' };
  }

  revalidatePath('/');
  revalidatePath('/queue');
  return {
    ok: true,
    message: `added ${parsed.data.company} — parked as needs-input${result.taskId ? '' : ' (task id unavailable)'}.`,
  };
}
