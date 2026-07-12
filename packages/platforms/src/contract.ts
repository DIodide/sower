import type {
  JobSpec,
  Platform,
  PlatformRef,
  ResolvedAnswer,
} from '@sower/core';

/** Common interface every ATS adapter implements. */
export interface PlatformAdapter {
  platform: Platform;
  /** Fetch and normalize a job posting (including its application questions) into a JobSpec. */
  discover(ref: PlatformRef, url: string): Promise<JobSpec>;
  /** Build the platform-specific submission payload from resolved answers. */
  buildSubmitPayload(
    spec: JobSpec,
    answers: ResolvedAnswer[],
  ): Record<string, unknown>;
  /**
   * Submit an application. GUARDRAIL: implementations must throw unless
   * SOWER_SUBMIT_ENABLED === 'true', and even then must only dry-run.
   */
  submit(
    spec: JobSpec,
    answers: ResolvedAnswer[],
  ): Promise<{ dryRun: boolean }>;
}
