'use server';

// Server actions for the resume editor (backend phase — the pages arrive
// next). Every mutation goes through the sower api's /resumes routes
// (API_BASE_URL, x-api-key auth via the shared apiRequest client) — the same
// pattern as the answer library. The api inserts a resume_runs row and starts
// the sower-resume-editor Cloud Run Job; the UI then polls getRunStatus until
// the run leaves 'running'.
//
// TRUTHFULNESS: `fired:false` from the api means the Job could NOT be started
// (the run row would sit 'running' forever) — actions surface that instead of
// pretending the work is underway.

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { apiRequest } from '../library';

export interface ResumeRunActionResult {
  ok: boolean;
  message: string;
  /** The resume_runs row to poll via getRunStatus, when one was recorded. */
  runId?: string;
}

const idSchema = z.string().uuid();

// Mirrors the api's askBodySchema (1-4000 chars after trim).
const promptSchema = z
  .string()
  .trim()
  .min(1, 'describe the change you want')
  .max(4000, 'change request must be at most 4,000 characters');

// Mirrors the api's editBodySchema cap.
const contentSchema = z
  .string()
  .min(1, 'resume source is empty')
  .max(200_000, 'resume source must be at most 200,000 characters');

const triggerResponseSchema = z.object({
  runId: z.string().uuid(),
  fired: z.boolean().optional(),
});

const runResponseSchema = z.object({
  run: z.object({
    id: z.string().uuid(),
    resumeId: z.string().uuid().nullish(),
    kind: z.enum(['sync', 'agent', 'write', 'fork']),
    status: z.enum(['running', 'succeeded', 'failed']),
    // Transcript steps pass through untyped; the viewer renders them.
    transcript: z.unknown().nullish(),
    commitSha: z.string().nullish(),
    error: z.string().nullish(),
    startedAt: z.string().nullish(),
    finishedAt: z.string().nullish(),
  }),
});

export type ResumeRunStatus = z.infer<typeof runResponseSchema>['run'];

export interface RunStatusResult {
  ok: boolean;
  message: string;
  run?: ResumeRunStatus;
}

function triggered(
  body: unknown,
  startedMessage: string,
): ResumeRunActionResult {
  const parsed = triggerResponseSchema.safeParse(body);
  if (!parsed.success) {
    return { ok: false, message: 'the api returned an unexpected run shape.' };
  }
  if (parsed.data.fired === false) {
    return {
      ok: false,
      message:
        'run recorded but the editor job could not be started — see api logs.',
      runId: parsed.data.runId,
    };
  }
  return { ok: true, message: startedMessage, runId: parsed.data.runId };
}

/** Repo-wide sync: recompile every resume and refresh the stored PDFs. */
export async function syncResumes(): Promise<ResumeRunActionResult> {
  const result = await apiRequest('/resumes/sync', { method: 'POST' });
  if (!result.ok) return { ok: false, message: result.message };
  revalidatePath('/answers/resumes');
  return triggered(result.body, 'sync started — resumes will refresh shortly.');
}

/** Natural-language change request: a Claude agent edits, compiles, pushes. */
export async function askResumeChange(
  id: string,
  prompt: string,
): Promise<ResumeRunActionResult> {
  const idParsed = idSchema.safeParse(id);
  if (!idParsed.success) return { ok: false, message: 'invalid resume id.' };
  const promptParsed = promptSchema.safeParse(prompt);
  if (!promptParsed.success) {
    return {
      ok: false,
      message: promptParsed.error.issues[0]?.message ?? 'invalid request',
    };
  }
  const result = await apiRequest(
    `/resumes/${encodeURIComponent(idParsed.data)}/ask`,
    { method: 'POST', body: { prompt: promptParsed.data } },
  );
  if (!result.ok) return { ok: false, message: result.message };
  revalidatePath('/answers/resumes');
  return triggered(
    result.body,
    'change request started — the agent is editing your resume.',
  );
}

/** Manual editor save: write the full LaTeX source, commit + push, rebuild. */
export async function saveResumeEdit(
  id: string,
  content: string,
): Promise<ResumeRunActionResult> {
  const idParsed = idSchema.safeParse(id);
  if (!idParsed.success) return { ok: false, message: 'invalid resume id.' };
  const contentParsed = contentSchema.safeParse(content);
  if (!contentParsed.success) {
    return {
      ok: false,
      message: contentParsed.error.issues[0]?.message ?? 'invalid source',
    };
  }
  const result = await apiRequest(
    `/resumes/${encodeURIComponent(idParsed.data)}/edit`,
    { method: 'POST', body: { content: contentParsed.data } },
  );
  if (!result.ok) return { ok: false, message: result.message };
  revalidatePath('/answers/resumes');
  return triggered(
    result.body,
    'save started — committing and recompiling your resume.',
  );
}

export interface CompilePreviewResult {
  ok: boolean;
  /** base64 PDF on success. */
  pdf?: string;
  /** Plain-text tectonic output (or a transport-level message) on failure. */
  log?: string;
}

// Mirrors the api's compile-preview 200 bodies; non-200s (404 unknown resume,
// 502 service unavailable, 503 not configured) surface through apiRequest's
// error message and normalize to a failed compile below.
const previewResponseSchema = z.union([
  z.object({ ok: z.literal(true), pdf: z.string() }),
  z.object({ ok: z.literal(false), log: z.string() }),
]);

/**
 * Throwaway preview compile for the split-pane editor. Never creates a
 * version or a run, commits nothing — the api compiles the posted source and
 * returns the PDF (or the compile log) inline.
 */
export async function compileResumePreview(
  resumeId: string,
  source: string,
): Promise<CompilePreviewResult> {
  const idParsed = idSchema.safeParse(resumeId);
  if (!idParsed.success) return { ok: false, log: 'invalid resume id.' };
  const contentParsed = contentSchema.safeParse(source);
  if (!contentParsed.success) {
    return {
      ok: false,
      log: contentParsed.error.issues[0]?.message ?? 'invalid source',
    };
  }
  const result = await apiRequest(
    `/resumes/${encodeURIComponent(idParsed.data)}/compile-preview`,
    { method: 'POST', body: { source: contentParsed.data } },
  );
  if (!result.ok) return { ok: false, log: result.message };
  const parsed = previewResponseSchema.safeParse(result.body);
  if (!parsed.success) {
    return { ok: false, log: 'the api returned an unexpected preview shape.' };
  }
  return parsed.data.ok
    ? { ok: true, pdf: parsed.data.pdf }
    : { ok: false, log: parsed.data.log };
}

// Mirrors the api's forkBodySchema (and FORK_NAME_RE in the editor job).
const forkNameSchema = z
  .string()
  .trim()
  .regex(
    /^[a-z0-9_-]{2,60}$/i,
    'name must be 2-60 letters/digits/dashes/underscores',
  );

const linkNameSchema = z
  .string()
  .trim()
  .min(1, 'give the link a name (e.g. the company)')
  .max(200, 'link name must be at most 200 characters');

const shareLinkSchema = z.object({
  id: z.string().uuid(),
  resumeId: z.string().uuid(),
  name: z.string(),
  token: z.string(),
  enabled: z.boolean(),
  viewCount: z.number(),
  lastViewedAt: z.string().nullish(),
  createdAt: z.string().nullish(),
  /** Full public URL (…/r/<token>) as the api rendered it. */
  url: z.string(),
});

export type ShareLink = z.infer<typeof shareLinkSchema>;

export interface ShareLinkResult {
  ok: boolean;
  message: string;
  link?: ShareLink;
}

export interface ShareLinkListResult {
  ok: boolean;
  message: string;
  links?: ShareLink[];
}

const versionSchema = z.object({
  id: z.string().uuid(),
  resumeId: z.string().uuid(),
  commitSha: z.string(),
  texSource: z.string(),
  /** Vault path — streamed via /answers/resumes/versions/[versionId]. */
  pdfStoragePath: z.string().nullish(),
  runId: z.string().uuid().nullish(),
  kind: z.enum(['agent', 'write', 'sync', 'fork']),
  createdAt: z.string().nullish(),
});

export type ResumeVersionEntry = z.infer<typeof versionSchema>;

export interface VersionListResult {
  ok: boolean;
  message: string;
  versions?: ResumeVersionEntry[];
}

/** Fork a resume: copy its current source to a new <name>.tex + new row. */
export async function forkResume(
  id: string,
  name: string,
): Promise<ResumeRunActionResult> {
  const idParsed = idSchema.safeParse(id);
  if (!idParsed.success) return { ok: false, message: 'invalid resume id.' };
  const nameParsed = forkNameSchema.safeParse(name);
  if (!nameParsed.success) {
    return {
      ok: false,
      message: nameParsed.error.issues[0]?.message ?? 'invalid name',
    };
  }
  const result = await apiRequest(
    `/resumes/${encodeURIComponent(idParsed.data)}/fork`,
    { method: 'POST', body: { name: nameParsed.data } },
  );
  if (!result.ok) return { ok: false, message: result.message };
  revalidatePath('/answers/resumes');
  return triggered(
    result.body,
    'fork started — the copy will appear once it compiles.',
  );
}

/** Create a named public share link (…/r/<token>) for a resume. */
export async function createShareLink(
  id: string,
  name: string,
): Promise<ShareLinkResult> {
  const idParsed = idSchema.safeParse(id);
  if (!idParsed.success) return { ok: false, message: 'invalid resume id.' };
  const nameParsed = linkNameSchema.safeParse(name);
  if (!nameParsed.success) {
    return {
      ok: false,
      message: nameParsed.error.issues[0]?.message ?? 'invalid link name',
    };
  }
  const result = await apiRequest(
    `/resumes/${encodeURIComponent(idParsed.data)}/links`,
    { method: 'POST', body: { name: nameParsed.data } },
  );
  if (!result.ok) return { ok: false, message: result.message };
  const parsed = z.object({ link: shareLinkSchema }).safeParse(result.body);
  if (!parsed.success) {
    return { ok: false, message: 'the api returned an unexpected link shape.' };
  }
  revalidatePath('/answers/resumes');
  return { ok: true, message: 'share link created.', link: parsed.data.link };
}

/** List a resume's share links (newest first). */
export async function listShareLinks(id: string): Promise<ShareLinkListResult> {
  const idParsed = idSchema.safeParse(id);
  if (!idParsed.success) return { ok: false, message: 'invalid resume id.' };
  const result = await apiRequest(
    `/resumes/${encodeURIComponent(idParsed.data)}/links`,
  );
  if (!result.ok) return { ok: false, message: result.message };
  const parsed = z
    .object({ links: z.array(shareLinkSchema) })
    .safeParse(result.body);
  if (!parsed.success) {
    return { ok: false, message: 'the api returned an unexpected link shape.' };
  }
  return { ok: true, message: 'ok', links: parsed.data.links };
}

/** Enable/disable (revoke) a share link. Disable IS the revoke. */
export async function setShareLinkEnabled(
  linkId: string,
  enabled: boolean,
): Promise<ShareLinkResult> {
  const idParsed = idSchema.safeParse(linkId);
  if (!idParsed.success) return { ok: false, message: 'invalid link id.' };
  const result = await apiRequest(
    `/resumes/links/${encodeURIComponent(idParsed.data)}/${enabled ? 'enable' : 'disable'}`,
    { method: 'POST' },
  );
  if (!result.ok) return { ok: false, message: result.message };
  const parsed = z.object({ link: shareLinkSchema }).safeParse(result.body);
  if (!parsed.success) {
    return { ok: false, message: 'the api returned an unexpected link shape.' };
  }
  revalidatePath('/answers/resumes');
  return {
    ok: true,
    message: enabled ? 'link re-enabled.' : 'link disabled.',
    link: parsed.data.link,
  };
}

/** Version history for a resume, newest first. */
export async function listVersions(id: string): Promise<VersionListResult> {
  const idParsed = idSchema.safeParse(id);
  if (!idParsed.success) return { ok: false, message: 'invalid resume id.' };
  const result = await apiRequest(
    `/resumes/${encodeURIComponent(idParsed.data)}/versions`,
  );
  if (!result.ok) return { ok: false, message: result.message };
  const parsed = z
    .object({ versions: z.array(versionSchema) })
    .safeParse(result.body);
  if (!parsed.success) {
    return {
      ok: false,
      message: 'the api returned an unexpected versions shape.',
    };
  }
  return { ok: true, message: 'ok', versions: parsed.data.versions };
}

/** Poll one run's status/transcript (the editor UI's progress view). */
export async function getRunStatus(runId: string): Promise<RunStatusResult> {
  const idParsed = idSchema.safeParse(runId);
  if (!idParsed.success) return { ok: false, message: 'invalid run id.' };
  const result = await apiRequest(
    `/resumes/runs/${encodeURIComponent(idParsed.data)}`,
  );
  if (!result.ok) return { ok: false, message: result.message };
  const parsed = runResponseSchema.safeParse(result.body);
  if (!parsed.success) {
    return { ok: false, message: 'the api returned an unexpected run shape.' };
  }
  return { ok: true, message: parsed.data.run.status, run: parsed.data.run };
}
