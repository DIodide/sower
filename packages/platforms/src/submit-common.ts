/**
 * Shared submit-side helpers for platform adapters (used by ashby + lever;
 * greenhouse keeps its original inline implementation).
 *
 * SAFETY: nothing in this module performs network I/O. Dry runs only build
 * a payload representation and hand one `{ phase: 'submit_dryrun',
 * dryRun: true }` record to the recorder; guarded submits throw unless
 * SOWER_SUBMIT_ENABLED === 'true' and even then only log the payload.
 */
import type { JobSpec, Platform, ResolvedAnswer } from '@sower/core';
import type { SubmitFile } from './contract.js';
import { type Recorder, safeRecord } from './recorder.js';

/** Key answers by question id, skipping unanswered (null) values. */
export function buildAnswerPayload(
  answers: ResolvedAnswer[],
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  for (const answer of answers) {
    if (answer.value === null) {
      continue;
    }
    payload[answer.questionId] = answer.value;
  }
  return payload;
}

/**
 * Complete a dry-run submit: attach file METADATA (contents never leave the
 * vault), record exactly one dryRun api call, return the payload. This
 * function must never call fetch or any other HTTP client.
 */
export async function recordDryRunSubmit(
  spec: JobSpec,
  payload: Record<string, unknown>,
  files: SubmitFile[],
  recorder?: Recorder,
): Promise<{ dryRun: true; payload: Record<string, unknown> }> {
  for (const file of files) {
    payload[file.questionId] = {
      kind: 'file',
      filename: file.filename,
      storagePath: file.storagePath,
    };
  }
  await safeRecord(recorder, {
    phase: 'submit_dryrun',
    method: 'POST',
    url: spec.applyUrl,
    requestBody: payload,
    dryRun: true,
    durationMs: 0,
  });
  return { dryRun: true, payload };
}

/**
 * GUARDRAIL: never actually posts an application. Throws unless
 * SOWER_SUBMIT_ENABLED === 'true'; when enabled it only logs the dry-run
 * payload and returns { dryRun: true }. No HTTP request is ever made here.
 */
export async function guardedDryRunOnlySubmit(
  platform: Platform,
  spec: JobSpec,
  payload: Record<string, unknown>,
): Promise<{ dryRun: boolean }> {
  if (process.env.SOWER_SUBMIT_ENABLED !== 'true') {
    throw new Error('submit disabled: SOWER_SUBMIT_ENABLED guardrail');
  }
  // Log only a field-key summary, never the applicant values (PII stays out
  // of logs even when submit mode is enabled for testing; the full payload is
  // recorded in the api_calls row, which is access-controlled).
  console.warn(
    `[sower] DRY RUN — ${platform} submit (no request was sent): applyUrl=${spec.applyUrl} fields=[${Object.keys(payload).join(', ')}]`,
  );
  return { dryRun: true };
}
