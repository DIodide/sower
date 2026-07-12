import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createInlineQueue,
  createQueue,
  type ProcessHandler,
} from './index.js';

const flushImmediates = () =>
  new Promise<void>((resolve) => setImmediate(resolve));

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createInlineQueue', () => {
  it('delivers the taskId to the handler', async () => {
    let resolveReceived!: (taskId: string) => void;
    const received = new Promise<string>((resolve) => {
      resolveReceived = resolve;
    });

    const queue = createInlineQueue(async (taskId) => {
      resolveReceived(taskId);
    });

    await queue.enqueueProcess('task-abc-123');
    await expect(received).resolves.toBe('task-abc-123');
  });

  it('swallows and logs handler rejections without crashing the caller', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let resolveInvoked!: () => void;
    const invoked = new Promise<void>((resolve) => {
      resolveInvoked = resolve;
    });

    const queue = createInlineQueue(async () => {
      resolveInvoked();
      throw new Error('boom');
    });

    await expect(queue.enqueueProcess('task-err-1')).resolves.toBeUndefined();
    await invoked;
    // Let the rejection propagate through the internal catch.
    await flushImmediates();
    await flushImmediates();

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain('task-err-1');
  });

  it('swallows synchronous handler throws too', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const syncThrower = (() => {
      throw new Error('sync boom');
    }) as unknown as ProcessHandler;

    const queue = createInlineQueue(syncThrower);

    await expect(queue.enqueueProcess('task-err-2')).resolves.toBeUndefined();
    await flushImmediates();
    await flushImmediates();

    expect(errorSpy).toHaveBeenCalledTimes(1);
  });
});

describe('createQueue', () => {
  it("returns a working inline queue when QUEUE_DRIVER is 'inline'", async () => {
    let resolveReceived!: (taskId: string) => void;
    const received = new Promise<string>((resolve) => {
      resolveReceived = resolve;
    });

    const queue = createQueue({ QUEUE_DRIVER: 'inline' }, async (taskId) => {
      resolveReceived(taskId);
    });

    await queue.enqueueProcess('task-from-factory');
    await expect(received).resolves.toBe('task-from-factory');
  });

  it("throws when QUEUE_DRIVER is 'inline' and no handler is given", () => {
    expect(() => createQueue({ QUEUE_DRIVER: 'inline' })).toThrow(
      /requires a process handler/,
    );
  });

  it("throws when QUEUE_DRIVER is 'cloud-tasks' and GCP options are missing", () => {
    expect(() =>
      createQueue({
        QUEUE_DRIVER: 'cloud-tasks',
        GCP_PROJECT_ID: 'sower-production',
      }),
    ).toThrow(/GCP_REGION.*TASKS_TARGET_BASE_URL.*INGEST_API_KEY/);
  });
});
