import { investigationRuns } from '@sower/db';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from './config.js';
import { triggerInvestigation } from './investigate-trigger.js';
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

const TASK_ID = '7d8e9f10-1112-4314-a516-b71819c2d2e2';

/** Fake db capturing investigation_runs inserts. */
function fakeDeps(configOverrides: Partial<Config> = {}) {
  const inserts: { table: unknown; values: unknown }[] = [];
  const db = {
    insert: (table: unknown) => ({
      values: async (values: unknown) => {
        inserts.push({ table, values });
        return [];
      },
    }),
  };
  const config = {
    SCREENSHOT_INVESTIGATION_ENABLED: true,
    GCP_PROJECT_ID: 'proj-1',
    GCP_REGION: 'us-central1',
    INVESTIGATOR_JOB_NAME: 'sower-investigator',
    ...configOverrides,
  } as unknown as Config;
  return { deps: { db, config } as unknown as Deps, inserts };
}

beforeEach(() => {
  runJobState.calls = [];
  runJobState.error = null;
});

describe('triggerInvestigation', () => {
  it('enabled: inserts a running run row and starts the Job with a TASK_ID override', async () => {
    const { deps, inserts } = fakeDeps();

    await expect(triggerInvestigation(deps, TASK_ID)).resolves.toBe(true);

    expect(inserts).toEqual([
      {
        table: investigationRuns,
        values: { taskId: TASK_ID, status: 'running' },
      },
    ]);
    expect(runJobState.calls).toEqual([
      {
        name: 'projects/proj-1/locations/us-central1/jobs/sower-investigator',
        overrides: {
          containerOverrides: [{ env: [{ name: 'TASK_ID', value: TASK_ID }] }],
        },
      },
    ]);
  });

  it('disabled: neither inserts a run nor starts the Job (fully dormant)', async () => {
    const { deps, inserts } = fakeDeps({
      SCREENSHOT_INVESTIGATION_ENABLED: false,
    });

    await expect(triggerInvestigation(deps, TASK_ID)).resolves.toBe(false);

    expect(inserts).toEqual([]);
    expect(runJobState.calls).toEqual([]);
  });

  it('enabled without GCP project/region: no-op instead of a broken Job name', async () => {
    const { deps, inserts } = fakeDeps({ GCP_PROJECT_ID: undefined });

    await expect(triggerInvestigation(deps, TASK_ID)).resolves.toBe(false);

    expect(inserts).toEqual([]);
    expect(runJobState.calls).toEqual([]);
  });

  it('swallows a runJob rejection — the caller NEVER sees a throw', async () => {
    runJobState.error = new Error('cloud run down');
    const { deps, inserts } = fakeDeps();

    // Still reports fired: the 'running' run row exists, so the reply's
    // "discovering form…" line matches what a refresh would render.
    await expect(triggerInvestigation(deps, TASK_ID)).resolves.toBe(true);

    // The run row was still recorded (a visible 'running' breadcrumb).
    expect(inserts).toHaveLength(1);
    expect(runJobState.calls).toHaveLength(1);
  });

  it('reuses a single lazily-constructed JobsClient across triggers', async () => {
    const { deps } = fakeDeps();

    await triggerInvestigation(deps, TASK_ID);
    await triggerInvestigation(deps, TASK_ID);

    expect(runJobState.constructed).toBe(1);
    expect(runJobState.calls).toHaveLength(2);
  });
});
