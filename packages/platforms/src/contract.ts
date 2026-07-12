import type {
  JobSpec,
  Platform,
  PlatformRef,
  ResolvedAnswer,
} from '@sower/core';
import type { Recorder } from './recorder.js';

/** File attachment metadata passed to dryRunSubmit (never file contents). */
export interface SubmitFile {
  questionId: string;
  storagePath: string;
  filename: string;
}

/** Options for a real (double-gated) submit. */
export interface SubmitOptions {
  recorder?: Recorder;
  /**
   * Reads the bytes of a stored document by its storage path so they can be
   * attached as multipart file parts. When absent, file parts are still added
   * but carry no bytes (the double gate below still governs whether any POST
   * happens at all).
   */
  getFileBytes?: (storagePath: string) => Promise<Uint8Array>;
}

/**
 * Result of submit(). Ashby/Lever stay dry-run only ({ dryRun: boolean }); a
 * double-gated real POST returns { submitted: true, status, dryRun: false }.
 */
export type SubmitResult =
  | { dryRun: boolean }
  | { submitted: true; status: number; dryRun: false };

/** Common interface every ATS adapter implements. */
export interface PlatformAdapter {
  platform: Platform;
  /** Fetch and normalize a job posting (including its application questions) into a JobSpec. */
  discover(
    ref: PlatformRef,
    url: string,
    opts?: { recorder?: Recorder },
  ): Promise<JobSpec>;
  /** Build the platform-specific submission payload from resolved answers. */
  buildSubmitPayload(
    spec: JobSpec,
    answers: ResolvedAnswer[],
  ): Record<string, unknown>;
  /**
   * Build and record the submission payload REPRESENTATION without any
   * network I/O. GUARDRAIL: implementations must never perform an HTTP
   * request here — they only construct the payload and hand one
   * `{ phase: 'submit_dryrun', dryRun: true }` record to the recorder.
   */
  dryRunSubmit(
    spec: JobSpec,
    answers: ResolvedAnswer[],
    files: SubmitFile[],
    opts?: { recorder?: Recorder },
  ): Promise<{ dryRun: true; payload: Record<string, unknown> }>;
  /**
   * Submit an application. GUARDRAIL: implementations must throw unless
   * SOWER_SUBMIT_ENABLED === 'true'. Dry-run-only adapters (ashby/lever) never
   * POST; the double-gated real path (greenhouse via realSubmit) additionally
   * requires an explicit SOWER_SUBMIT_TARGET_URL and never uses spec.applyUrl.
   */
  submit(
    spec: JobSpec,
    answers: ResolvedAnswer[],
    files?: SubmitFile[],
    opts?: SubmitOptions,
  ): Promise<SubmitResult>;
}
