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
   * SOWER_SUBMIT_ENABLED === 'true', and even then must only dry-run.
   */
  submit(
    spec: JobSpec,
    answers: ResolvedAnswer[],
  ): Promise<{ dryRun: boolean }>;
}
