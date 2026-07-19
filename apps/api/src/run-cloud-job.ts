import { JobsClient } from '@google-cloud/run';
import type { Deps } from './types.js';

/**
 * Shared Cloud Run Jobs trigger: start ONE execution of a named Job with
 * per-execution env overrides. Used by the investigator trigger
 * (investigate-trigger.ts) and the resume-editor routes (resume-routes.ts).
 *
 * Fire-and-forget: runJob resolves once the execution is STARTED (the
 * initial RPC); the long-running operation itself is never awaited to
 * completion — each Job reports its outcome out of band (HTTP callback or
 * direct DB writes). Throws on RPC/config failure; callers decide whether
 * that is fatal (both current callers log and carry on).
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

export async function runCloudJob(
  deps: Deps,
  jobName: string,
  env: Record<string, string>,
): Promise<void> {
  const { config } = deps;
  if (!config.GCP_PROJECT_ID || !config.GCP_REGION) {
    throw new Error(
      `cannot start Cloud Run Job '${jobName}': GCP_PROJECT_ID/GCP_REGION unset`,
    );
  }
  const name = `projects/${config.GCP_PROJECT_ID}/locations/${config.GCP_REGION}/jobs/${jobName}`;
  await getJobsClient().runJob({
    name,
    overrides: {
      containerOverrides: [
        {
          env: Object.entries(env).map(([key, value]) => ({
            name: key,
            value,
          })),
        },
      ],
    },
  });
}
