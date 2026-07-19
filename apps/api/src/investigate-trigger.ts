import { investigationRuns } from '@sower/db';
import { runCloudJob } from './run-cloud-job.js';
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
 * Record an investigation_runs row and start one Cloud Run Job execution for
 * `taskId` (passed to the container via a TASK_ID env override). Starting the
 * execution is fire-and-forget (see runCloudJob): the Job reports back over
 * HTTP when it finishes.
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
    // the runCloudJob RPC below fails, the reply/refresh state stays
    // consistent.
    fired = true;
    await runCloudJob(deps, config.INVESTIGATOR_JOB_NAME, { TASK_ID: taskId });
  } catch (error) {
    console.error(
      `[sower] investigation trigger failed for task ${taskId}:`,
      error,
    );
  }
  return fired;
}
