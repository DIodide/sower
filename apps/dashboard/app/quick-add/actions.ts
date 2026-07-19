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

/** Mirrors the api's POST /ingest/paste cap. */
const PASTE_MAX_CHARS = 50_000;

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
  /** URLs beyond the api's 25-per-paste cap that were NOT processed. */
  truncated: z.number().optional(),
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
  // Distinct messages: an empty paste and an oversized one are different
  // user mistakes and deserve different fixes.
  if (typeof text !== 'string' || text.trim() === '') {
    return { ok: false, message: 'paste some text first.' };
  }
  if (text.length > PASTE_MAX_CHARS) {
    return {
      ok: false,
      message: "that's over the 50,000-character limit — trim it down.",
    };
  }

  const response = await postApi('/ingest/paste', { text });
  if (!(response instanceof Response)) return response;
  if (!response.ok) return failureMessage('paste ingest', response);

  let summary: z.infer<typeof pasteResponseSchema>;
  try {
    summary = pasteResponseSchema.parse(await response.json());
  } catch {
    return { ok: false, message: 'unexpected api response — see api logs.' };
  }

  revalidatePath('/');

  if (summary.urls === 0) {
    return {
      ok: true,
      message:
        'no links found in the pasted text — for a job without a URL, use manual add.',
    };
  }
  // Human words, no pipeline jargon: "Added 1 · already tracked 1 · saved
  // for review 1".
  const parts: string[] = [];
  if (summary.ingested > 0) parts.push(`Added ${summary.ingested}`);
  if (summary.duplicates > 0) {
    parts.push(`already tracked ${summary.duplicates}`);
  }
  if (summary.unsupported > 0) {
    parts.push(`saved for review ${summary.unsupported}`);
  }
  if (summary.directories > 0) {
    parts.push(
      `opened ${summary.directories} link list${summary.directories === 1 ? '' : 's'}`,
    );
  }
  if (summary.errors > 0) parts.push(`${summary.errors} failed`);
  const truncated = summary.truncated ?? 0;
  if (truncated > 0) {
    parts.push(
      `only the first 25 links were processed (${truncated} skipped) — paste the rest separately`,
    );
  }
  return {
    // Errors are reported, not swallowed — but partial success is success.
    ok: summary.errors < summary.urls,
    message: parts.join(' · '),
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

  try {
    manualResponseSchema.parse(await response.json());
  } catch {
    return { ok: false, message: 'unexpected api response — see api logs.' };
  }

  revalidatePath('/');
  return {
    ok: true,
    message: `${parsed.data.company} saved — it's in "Waiting on you".`,
  };
}
