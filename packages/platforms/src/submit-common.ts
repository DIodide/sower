/**
 * Shared submit-side helpers for platform adapters.
 *
 * SAFETY: the dry-run helpers (recordDryRunSubmit, guardedDryRunOnlySubmit)
 * perform ZERO network I/O — they build a payload representation and, at most,
 * hand one `{ phase: 'submit_dryrun', dryRun: true }` record to the recorder;
 * guardedDryRunOnlySubmit throws unless SOWER_SUBMIT_ENABLED === 'true' and
 * even then only logs. The ONLY function here that can POST is realSubmit, and
 * it is double-gated (SOWER_SUBMIT_ENABLED === 'true' AND an explicit
 * SOWER_SUBMIT_TARGET_URL) and never targets spec.applyUrl.
 */
import type { JobSpec, Platform, ResolvedAnswer } from '@sower/core';
import type { SubmitFile, SubmitOptions } from './contract.js';
import { type Recorder, recordedFetch, safeRecord } from './recorder.js';

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

/**
 * DOUBLE-GATED real submit — the ONLY code in this repo that may POST an
 * application. Both gates must pass or NO network request is made:
 *
 *   Gate 1: SOWER_SUBMIT_ENABLED === 'true' (else throws; unchanged guardrail).
 *   Gate 2: an explicit SOWER_SUBMIT_TARGET_URL (else throws).
 *
 * SAFETY: the POST target is ALWAYS process.env.SOWER_SUBMIT_TARGET_URL and is
 * NEVER derived from spec.applyUrl — so an accidental POST to a real employer
 * is structurally impossible. The body is multipart/form-data: scalar/array
 * fields from `payload` plus one file part per `files[]` entry (bytes read via
 * opts.getFileBytes when provided, otherwise an empty part). The request is
 * recorded through recordedFetch under phase 'submit'.
 */
export async function realSubmit(
  platform: Platform,
  spec: JobSpec,
  payload: Record<string, unknown>,
  files: SubmitFile[],
  opts?: SubmitOptions,
): Promise<{ submitted: true; status: number; dryRun: false }> {
  // Gate 1: master enable switch.
  if (process.env.SOWER_SUBMIT_ENABLED !== 'true') {
    throw new Error('submit disabled: SOWER_SUBMIT_ENABLED guardrail');
  }
  // Gate 2: an explicit target. We refuse to default to spec.applyUrl so a
  // real employer is never posted to by accident.
  const target = process.env.SOWER_SUBMIT_TARGET_URL;
  if (!target) {
    throw new Error(
      'refusing to submit: no explicit SOWER_SUBMIT_TARGET_URL; will not POST to a real employer by default',
    );
  }

  const form = new FormData();
  for (const [key, value] of Object.entries(payload)) {
    if (value === null || value === undefined) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        form.append(key, String(item));
      }
    } else {
      form.append(key, String(value));
    }
  }
  for (const file of files) {
    const bytes: Uint8Array = opts?.getFileBytes
      ? await opts.getFileBytes(file.storagePath)
      : new Uint8Array();
    // Cast: a Uint8Array is a valid BlobPart at runtime; the DOM lib's
    // BlobPart narrows the backing buffer to ArrayBuffer (excluding
    // SharedArrayBuffer), which a generic Uint8Array type does not guarantee.
    form.append(file.questionId, new Blob([bytes as BlobPart]), file.filename);
  }

  // Log identity + the field/file KEYS only (never applicant values) and the
  // explicit target — deliberately NOT spec.applyUrl, which is never posted to.
  console.warn(
    `[sower] REAL SUBMIT — ${platform} ${spec.tenant}/${spec.externalId} → ${target} fields=[${Object.keys(
      payload,
    ).join(', ')}] files=[${files.map((file) => file.questionId).join(', ')}]`,
  );
  const response = await recordedFetch(opts?.recorder, 'submit', target, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(30_000),
  });
  return { submitted: true, status: response.status, dryRun: false };
}
