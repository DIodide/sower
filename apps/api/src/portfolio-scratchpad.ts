import type { Question } from '@sower/core';
import { applicationTasks, jobNotes, jobs } from '@sower/db';
import { asc, eq } from 'drizzle-orm';
import type { Deps } from './types.js';

/**
 * Write-through mirror of a task's job notes into the private portfolio
 * repo: private/jobs/<company_slug>/<job_slug>/scratchpad.md. The DB is the
 * source of truth — the file is regenerated IN FULL on every note mutation
 * (self-healing: the next mutation repairs any missed/failed write), and
 * out-of-band edits to the file are never synced back.
 *
 * Contents API pattern mirrored from apps/resume-editor github.ts (no
 * cross-app import): a GET fetches the current blob sha and a PUT commits
 * the regenerated content against it — GitHub 409s if the file moved
 * underneath us, and the next mutation's full regenerate wins it back.
 *
 * TOKEN MECHANICS: the token travels ONLY in the Authorization header —
 * never in a URL — and every failure detail is scrubbed of it before being
 * reported, so no outcome string can leak it into logs or the dashboard.
 */

export const PORTFOLIO_OWNER_REPO = 'DIodide/portfolio';
const GITHUB_API_BASE = 'https://api.github.com';
const REQUEST_TIMEOUT_MS = 30_000;
/** Keep reported failures readable; GitHub error bodies can carry HTML. */
const ERROR_DETAIL_CHARS = 200;
const SLUG_MAX_CHARS = 60;

/** One note as the renderer needs it (a resolved label, not a row). */
export interface ScratchpadNote {
  body: string;
  /** Human label of the tied question; undefined = a general note. */
  questionLabel?: string;
}

/**
 * The per-mutation mirror outcome the routes report verbatim: a GitHub
 * failure NEVER fails the request — the note is in the DB and the next
 * mutation re-mirrors the whole file.
 */
export type ScratchpadSyncOutcome =
  | 'mirrored'
  | 'skipped: no token'
  | `failed: ${string}`;

/**
 * Path/segment slug: lowercase, every non-[a-z0-9] run collapses to one
 * '-', trimmed of leading/trailing '-', capped at 60 chars (re-trimmed so
 * the cap never leaves a dangling '-'). Empty input yields the fallback.
 */
export function slugify(
  value: string | null | undefined,
  fallback: string,
): string {
  const slug = (value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX_CHARS)
    .replace(/-+$/, '');
  return slug === '' ? fallback : slug;
}

/**
 * Render the scratchpad file: for each note (created_at asc) an optional
 * first line `Q: <question label>`, then the body, then a line containing
 * exactly `--end` — the terminator follows EVERY note, the last included.
 * A body line that IS the terminator (trimmed) is escaped to `\--end` so a
 * note can never split itself; no notes renders the empty file (the mirror
 * writes it rather than deleting the path).
 */
export function renderScratchpad(notes: ScratchpadNote[]): string {
  const parts: string[] = [];
  for (const note of notes) {
    if (note.questionLabel !== undefined) {
      parts.push(`Q: ${note.questionLabel}`);
    }
    const body = note.body
      .split('\n')
      .map((line) => (line.trim() === '--end' ? '\\--end' : line))
      .join('\n');
    parts.push(body);
    parts.push('--end');
  }
  return parts.length === 0 ? '' : `${parts.join('\n')}\n`;
}

/** Repo-relative scratchpad path for a task's company/title identity. */
export function scratchpadPath(
  company: string | null | undefined,
  title: string | null | undefined,
  taskId: string,
): string {
  const companySlug = slugify(company, 'unknown-company');
  const jobSlug = slugify(title, `task-${taskId.slice(0, 8)}`);
  return `private/jobs/${companySlug}/${jobSlug}/scratchpad.md`;
}

function contentsUrl(repoPath: string): string {
  const encoded = repoPath.split('/').map(encodeURIComponent).join('/');
  return `${GITHUB_API_BASE}/repos/${PORTFOLIO_OWNER_REPO}/contents/${encoded}`;
}

function baseHeaders(token: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'sower-api',
  };
}

/** Failure detail with the token scrubbed and the length capped. */
function safeDetail(raw: string, token: string): string {
  return raw.split(token).join('[redacted]').slice(0, ERROR_DETAIL_CHARS);
}

/**
 * Regenerate + push the scratchpad for a task from the DB (the full mirror:
 * every note, oldest first, tied labels resolved from the task's jobSpec
 * with the raw id as the fallback). Never throws — the outcome string is
 * the whole report.
 */
export async function mirrorTaskScratchpad(
  deps: Deps,
  taskId: string,
): Promise<ScratchpadSyncOutcome> {
  const token = deps.config.GITHUB_PORTFOLIO_TOKEN;
  if (token === undefined || token === '') {
    return 'skipped: no token';
  }
  try {
    const rows = await deps.db
      .select({ task: applicationTasks, job: jobs })
      .from(applicationTasks)
      .innerJoin(jobs, eq(applicationTasks.jobId, jobs.id))
      .where(eq(applicationTasks.id, taskId))
      .limit(1);
    const row = rows[0];
    if (!row) {
      return 'failed: task not found';
    }
    const noteRows = await deps.db
      .select()
      .from(jobNotes)
      .where(eq(jobNotes.taskId, taskId))
      .orderBy(asc(jobNotes.createdAt));
    // The same identity fallback the rest of the app uses: the jobs row
    // first, then the jobSpec.
    const spec = row.task.jobSpec;
    const company = row.job.company ?? spec?.company ?? null;
    const title = row.job.title ?? spec?.title ?? null;
    const labelById = new Map<string, string>(
      (spec?.questions ?? []).map((q: Question) => [q.id, q.label]),
    );
    const content = renderScratchpad(
      noteRows.map((note) => ({
        body: note.body,
        ...(note.questionId !== null
          ? { questionLabel: labelById.get(note.questionId) ?? note.questionId }
          : {}),
      })),
    );
    const repoPath = scratchpadPath(company, title, taskId);
    const url = contentsUrl(repoPath);

    // GET the current blob for its sha; 404 = the file doesn't exist yet
    // (the PUT below creates it by omitting sha).
    const getResponse = await fetch(url, {
      headers: baseHeaders(token),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    let sha: string | undefined;
    if (getResponse.ok) {
      const body = (await getResponse.json()) as { sha?: unknown };
      if (typeof body.sha === 'string') {
        sha = body.sha;
      }
    } else if (getResponse.status !== 404) {
      const detail = await getResponse.text().catch(() => '');
      return `failed: GitHub GET ${getResponse.status}: ${safeDetail(detail, token)}`;
    }

    const putResponse = await fetch(url, {
      method: 'PUT',
      headers: { ...baseHeaders(token), 'content-type': 'application/json' },
      body: JSON.stringify({
        message: `sower: scratchpad — ${company ?? 'unknown company'} / ${title ?? 'untitled role'}`,
        content: Buffer.from(content, 'utf8').toString('base64'),
        ...(sha !== undefined ? { sha } : {}),
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!putResponse.ok) {
      const detail = await putResponse.text().catch(() => '');
      return `failed: GitHub PUT ${putResponse.status}: ${safeDetail(detail, token)}`;
    }
    return 'mirrored';
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `failed: ${safeDetail(message, token)}`;
  }
}
