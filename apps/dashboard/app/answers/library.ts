// Server-side client for the sower api's /answer-library routes.
//
// The dashboard never talks to the answers table directly from this page —
// all reads and mutations for the answer library go through OUR api service
// (API_BASE_URL, x-api-key auth), exactly like requeue/approve. The base URL
// comes from our own deployment env, never from user input or job data.
//
// SCOPING MODEL (mirrors @sower/answers): `company` is a normalized company
// key (lowercase, trimmed); the empty string means GLOBAL. A company-scoped
// answer resolves only for its company; a global answer is the fallback when
// no company-scoped answer exists for that (company, question).

import { isBankOptionValue } from '@sower/answers';
import { z } from 'zod';

export interface LibraryEntry {
  id: string;
  /** Normalized company key; '' means the answer is GLOBAL. */
  company: string;
  questionLabel: string;
  normalizedLabel: string;
  /**
   * Display/edit string. Select answers stored as {value,label} show their
   * human LABEL (not the platform's option id); arrays are comma-joined.
   * Editing saves the edited text back as a plain string, which still
   * resolves — the resolver matches option labels first.
   */
  value: string;
  /** ISO timestamp of the last change, when the api provides one. */
  updatedAt: string | null;
}

export type LibraryResult =
  | { ok: true; entries: LibraryEntry[] }
  | { ok: false; message: string };

const rawEntrySchema = z.object({
  id: z.string().uuid(),
  company: z.string().nullish(),
  questionLabel: z.string(),
  normalizedLabel: z.string().nullish(),
  value: z.unknown(),
  updatedAt: z.string().nullish(),
});

// Tolerate either a bare array or a wrapped list ({answers}/{entries}/{items}).
const listResponseSchema = z.union([
  z.array(rawEntrySchema),
  z.object({ answers: z.array(rawEntrySchema) }),
  z.object({ entries: z.array(rawEntrySchema) }),
  z.object({ items: z.array(rawEntrySchema) }),
]);

const errorBodySchema = z.object({
  error: z.string().optional(),
  message: z.string().optional(),
});

function displayValue(value: unknown): string {
  if (typeof value === 'string') return value;
  // New-shape select answers ({value,label}) read as their human label —
  // never the platform-internal option id ('4128291002', 'yes_17').
  if (isBankOptionValue(value)) return value.label;
  if (Array.isArray(value)) {
    return value
      .map((v) => (isBankOptionValue(v) ? v.label : String(v)))
      .join(', ');
  }
  if (value === null || value === undefined) return '';
  return JSON.stringify(value);
}

export interface ApiConfig {
  base: string;
  apiKey: string;
}

/** Reads API_BASE_URL / INGEST_API_KEY; null when the api is unconfigured. */
export function getApiConfig(): ApiConfig | null {
  const base = process.env.API_BASE_URL;
  const apiKey = process.env.INGEST_API_KEY;
  if (!base || !apiKey) return null;
  return { base: base.replace(/\/$/, ''), apiKey };
}

export const API_UNCONFIGURED_MESSAGE =
  'api service is not configured (API_BASE_URL / INGEST_API_KEY missing).';

/**
 * Call a /answer-library route on the sower api service. Returns the parsed
 * JSON body on 2xx; a human-readable error otherwise. Never throws.
 */
export async function apiRequest(
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<{ ok: true; body: unknown } | { ok: false; message: string }> {
  const config = getApiConfig();
  if (!config) return { ok: false, message: API_UNCONFIGURED_MESSAGE };

  let response: Response;
  try {
    response = await fetch(`${config.base}${path}`, {
      method: init?.method ?? 'GET',
      headers: {
        'x-api-key': config.apiKey,
        ...(init?.body !== undefined
          ? { 'content-type': 'application/json' }
          : {}),
      },
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
      cache: 'no-store',
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    return {
      ok: false,
      message: `could not reach the api service: ${err instanceof Error ? err.message : 'unknown error'}`,
    };
  }

  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // Empty or non-JSON body: fall through to status-based messaging.
  }

  if (!response.ok) {
    const parsed = errorBodySchema.safeParse(body);
    const detail = parsed.success
      ? (parsed.data.error ?? parsed.data.message)
      : undefined;
    return {
      ok: false,
      message: `api request failed (${response.status}): ${detail ?? 'see api logs'}`,
    };
  }
  return { ok: true, body };
}

/** Fetch every answer-library entry (global + all companies). */
export async function fetchAnswerLibrary(): Promise<LibraryResult> {
  const result = await apiRequest('/answer-library');
  if (!result.ok) return result;

  const parsed = listResponseSchema.safeParse(result.body);
  if (!parsed.success) {
    return {
      ok: false,
      message: 'the api returned an unexpected answer-library shape.',
    };
  }
  const rows = Array.isArray(parsed.data)
    ? parsed.data
    : 'answers' in parsed.data
      ? parsed.data.answers
      : 'entries' in parsed.data
        ? parsed.data.entries
        : parsed.data.items;

  return {
    ok: true,
    entries: rows.map((row) => ({
      id: row.id,
      company: (row.company ?? '').toLowerCase().trim(),
      questionLabel: row.questionLabel,
      normalizedLabel: row.normalizedLabel ?? '',
      value: displayValue(row.value),
      updatedAt: row.updatedAt ?? null,
    })),
  };
}
