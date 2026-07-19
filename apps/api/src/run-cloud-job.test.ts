import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from './config.js';
import { runCloudJob } from './run-cloud-job.js';
import type { Deps } from './types.js';

const runJobState = vi.hoisted(() => ({
  calls: [] as unknown[],
  error: null as Error | null,
  constructed: 0,
}));

vi.mock('@google-cloud/run', () => ({
  JobsClient: class {
    constructor() {
      runJobState.constructed += 1;
    }
    async runJob(request: unknown): Promise<unknown[]> {
      runJobState.calls.push(request);
      if (runJobState.error) {
        throw runJobState.error;
      }
      // The long-running operation tuple (never awaited to completion).
      return [{ name: 'operations/exec-1' }];
    }
  },
}));

function fakeDeps(configOverrides: Partial<Config> = {}): Deps {
  const config = {
    GCP_PROJECT_ID: 'proj-1',
    GCP_REGION: 'us-central1',
    ...configOverrides,
  } as unknown as Config;
  return { config } as unknown as Deps;
}

beforeEach(() => {
  runJobState.calls = [];
  runJobState.error = null;
});

describe('runCloudJob', () => {
  it('starts the named Job with the env overrides mapped to containerOverrides', async () => {
    await runCloudJob(fakeDeps(), 'sower-resume-editor', {
      RESUME_RUN_ID: 'run-1',
    });

    expect(runJobState.calls).toEqual([
      {
        name: 'projects/proj-1/locations/us-central1/jobs/sower-resume-editor',
        overrides: {
          containerOverrides: [
            { env: [{ name: 'RESUME_RUN_ID', value: 'run-1' }] },
          ],
        },
      },
    ]);
  });

  it('maps multiple env overrides in order', async () => {
    await runCloudJob(fakeDeps(), 'sower-investigator', {
      TASK_ID: 'task-1',
      EXTRA: 'x',
    });

    expect(runJobState.calls).toEqual([
      expect.objectContaining({
        overrides: {
          containerOverrides: [
            {
              env: [
                { name: 'TASK_ID', value: 'task-1' },
                { name: 'EXTRA', value: 'x' },
              ],
            },
          ],
        },
      }),
    ]);
  });

  it('throws (without an RPC) when GCP project/region are unset', async () => {
    await expect(
      runCloudJob(fakeDeps({ GCP_PROJECT_ID: undefined }), 'j', {}),
    ).rejects.toThrow(/GCP_PROJECT_ID\/GCP_REGION unset/);
    expect(runJobState.calls).toEqual([]);
  });

  it('propagates an RPC failure to the caller', async () => {
    runJobState.error = new Error('cloud run down');
    await expect(runCloudJob(fakeDeps(), 'j', {})).rejects.toThrow(
      'cloud run down',
    );
  });

  it('reuses a single lazily-constructed JobsClient across calls', async () => {
    const before = runJobState.constructed;
    await runCloudJob(fakeDeps(), 'a', {});
    await runCloudJob(fakeDeps(), 'b', {});
    // At most one construction within this test file's module graph.
    expect(runJobState.constructed - before).toBeLessThanOrEqual(1);
    expect(runJobState.calls).toHaveLength(2);
  });
});
