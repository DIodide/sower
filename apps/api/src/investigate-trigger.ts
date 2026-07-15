import { JobsClient } from '@google-cloud/run';
import { investigationRuns } from '@sower/db';
import type { Deps } from './types.js';

/**
 * Tier-2 screenshot investigation trigger: when a screenshot task is parked,
 * fire the `sower-investigator` Cloud Run Job for it. The Job runs the
 * @sower/investigate agent and POSTs `{ result, transcript }` back to
 * POST /tasks/:id/investigation-result (see server.ts).
 *
 * Fully dormant unless config.SCREENSHOT_INVESTIGATION_ENABLED is true, and
 * NEVER throws: a Job that fails to start must not fail the Discord poll or
 * drop the parked task — the failure is logged and the run row (if inserted)
 * stays 'running' as a visible breadcrumb.
 */

/**
 * Lazily-constructed singleton (mirrors @sower/queue's CloudTasksClient):
 * authenticates via ADC on Cloud Run — no key material.
 */
let jobsClient: JobsClient | null = null;

function getJobsClient(): JobsClient {
  if (jobsClient === null) {
    jobsClient = new JobsClient();
  }
  return jobsClient;
}

/**
 * Record an investigation_runs row and start one Cloud Run Job execution for
 * `taskId` (passed to the container via a TASK_ID env override). Starting the
 * execution is fire-and-forget: the returned long-running operation is NOT
 * awaited to completion — the Job reports back over HTTP when it finishes.
 *
 * Returns true once the 'running' run row was recorded (an investigation is
 * visibly underway), so the #ingest reply can honestly render "discovering
 * form…"; false when the feature is gated off or nothing was recorded.
 */
export async function triggerInvestigation(
  deps: Deps,
  taskId: string,
): Promise<boolean> {
  const { config } = deps;
  if (!config.SCREENSHOT_INVESTIGATION_ENABLED) {
    return false;
  }
  if (!config.GCP_PROJECT_ID || !config.GCP_REGION) {
    console.warn(
      `[sower] investigation enabled but GCP_PROJECT_ID/GCP_REGION unset; not triggering for task ${taskId}`,
    );
    return false;
  }
  let fired = false;
  try {
    await deps.db
      .insert(investigationRuns)
      .values({ taskId, status: 'running' });
    // The run row is the visible "investigation underway" breadcrumb: even if
    // the runJob RPC below fails, the reply/refresh state stays consistent.
    fired = true;
    const name = `projects/${config.GCP_PROJECT_ID}/locations/${config.GCP_REGION}/jobs/${config.INVESTIGATOR_JOB_NAME}`;
    // Resolves once the execution is STARTED (the initial RPC); the
    // operation itself is left running.
    await getJobsClient().runJob({
      name,
      overrides: {
        containerOverrides: [{ env: [{ name: 'TASK_ID', value: taskId }] }],
      },
    });
  } catch (error) {
    console.error(
      `[sower] investigation trigger failed for task ${taskId}:`,
      error,
    );
  }
  return fired;
}
