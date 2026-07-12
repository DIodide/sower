import type { ApplicationTask } from '@sower/db';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BROWSER_TIER_STATE,
  createBrowserWorker,
  NotImplementedError,
} from './browser-worker.js';

// Partial on purpose (then cast): the db schema gains columns in parallel
// migrations (e.g. approval_channel_id) and this scaffold test must not
// break when the inferred row type widens.
const task = {
  id: '3f0c8dbb-6f5e-4b57-9b1c-2a54d2b3c111',
  state: 'FILLING',
  attempt: 1,
} as ApplicationTask;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createBrowserWorker (scaffold)', () => {
  it('fill() rejects with NotImplementedError and logs the scaffold notice', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const worker = createBrowserWorker();

    await expect(worker.fill(task)).rejects.toBeInstanceOf(NotImplementedError);
    await expect(worker.fill(task)).rejects.toThrow(
      /T1\/T2\/T3 browser tiers: scaffold only/,
    );
    expect(log).toHaveBeenCalledWith('T1/T2/T3 browser tiers: scaffold only');
  });

  it('performs zero network I/O — fetch is never called (no submit possible)', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const worker = createBrowserWorker();

    await expect(worker.fill(task)).rejects.toBeInstanceOf(NotImplementedError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('names the task in the error for debuggability', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await expect(createBrowserWorker().fill(task)).rejects.toThrow(task.id);
  });

  it('operates in the FILLING state per the core state machine', () => {
    expect(BROWSER_TIER_STATE).toBe('FILLING');
  });
});
