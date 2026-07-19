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
    kind: z.enum(['sync', 'agent', 'write']),
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
