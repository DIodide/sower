import type { ApiCallRecord } from '@sower/platforms';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTaskRecorder } from './recorder.js';
import type { Deps } from './types.js';

interface FakeDbOptions {
  /** Result of the max(seq) lookup (null = no rows yet for the task). */
  maxSeq: number | null;
  /** When true, every insert rejects. */
  failInserts?: boolean;
  /** When true, the max(seq) select rejects. */
  failSelect?: boolean;
}

function createFakeDb(options: FakeDbOptions) {
  const inserted: Record<string, unknown>[] = [];
  const counters = { selects: 0, inserts: 0 };

  const db = {
    select: () => {
      counters.selects += 1;
      const result = options.failSelect
        ? Promise.reject(new Error('select failed'))
        : Promise.resolve([{ max: options.maxSeq }]);
      const chain = {
        from: () => chain,
        where: () => chain,
        // biome-ignore lint/suspicious/noThenProperty: mimics drizzle's awaitable builder
        then: (
          onFulfilled: (value: unknown) => unknown,
          onRejected?: (reason: unknown) => unknown,
        ) => result.then(onFulfilled, onRejected),
      };
      return chain;
    },
    insert: () => ({
      values: (row: Record<string, unknown>) => {
        counters.inserts += 1;
        const result = options.failInserts
          ? Promise.reject(new Error('insert failed'))
          : Promise.resolve().then(() => {
              inserted.push(row);
              return [];
            });
        return {
          // biome-ignore lint/suspicious/noThenProperty: mimics drizzle's awaitable builder
          then: (
            onFulfilled: (value: unknown) => unknown,
            onRejected?: (reason: unknown) => unknown,
          ) => result.then(onFulfilled, onRejected),
        };
      },
    }),
  };

  return { db: db as unknown as Deps['db'], inserted, counters };
}

function call(overrides: Partial<ApiCallRecord> = {}): ApiCallRecord {
  return {
    phase: 'discover',
    method: 'GET',
    url: 'https://boards-api.greenhouse.io/v1/boards/acme/jobs/1',
    durationMs: 12,
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createTaskRecorder', () => {
  it('starts seq at max(seq)+1 and increments per record (one insert each)', async () => {
    const { db, inserted, counters } = createFakeDb({ maxSeq: 4 });
    const recorder = createTaskRecorder(db, 'task-1');

    await recorder(call({ responseStatus: 200 }));
    await recorder(
      call({
        phase: 'submit_dryrun',
        method: 'POST',
        url: 'https://boards.greenhouse.io/acme/jobs/123',
        requestBody: { email: 'x' },
        dryRun: true,
        durationMs: 0,
      }),
    );

    expect(inserted).toHaveLength(2);
    expect(counters.inserts).toBe(2);
    // max(seq) is looked up exactly once, lazily on the first record.
    expect(counters.selects).toBe(1);
    expect(inserted.map((row) => row.seq)).toEqual([5, 6]);
    expect(inserted[0]).toMatchObject({
      taskId: 'task-1',
      seq: 5,
      phase: 'discover',
      method: 'GET',
      responseStatus: 200,
      durationMs: 12,
      dryRun: false,
    });
    expect(inserted[1]).toMatchObject({
      taskId: 'task-1',
      seq: 6,
      phase: 'submit_dryrun',
      method: 'POST',
      requestBody: { email: 'x' },
      dryRun: true,
      durationMs: 0,
    });
  });

  it('starts seq at 1 when the task has no api_calls yet', async () => {
    const { db, inserted } = createFakeDb({ maxSeq: null });
    const recorder = createTaskRecorder(db, 'task-1');
    await recorder(call());
    expect(inserted.map((row) => row.seq)).toEqual([1]);
  });

  it('never throws when the insert fails (logs a warning instead)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { db, inserted } = createFakeDb({ maxSeq: 0, failInserts: true });
    const recorder = createTaskRecorder(db, 'task-1');

    await expect(recorder(call())).resolves.toBeUndefined();

    expect(inserted).toHaveLength(0);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('never throws when the max(seq) lookup fails, and later records still work', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const options: FakeDbOptions = { maxSeq: 2, failSelect: true };
    const { db, inserted } = createFakeDb(options);
    const recorder = createTaskRecorder(db, 'task-1');

    await expect(recorder(call())).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(inserted).toHaveLength(0);

    // The db recovers: the next record retries the lookup and persists.
    options.failSelect = false;
    await recorder(call());
    expect(inserted.map((row) => row.seq)).toEqual([3]);
  });
});
