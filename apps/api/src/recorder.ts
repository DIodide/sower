import { apiCalls } from '@sower/db';
import type { ApiCallRecord, Recorder } from '@sower/platforms';
import { eq, sql } from 'drizzle-orm';
import type { Db } from './types.js';

/**
 * Recorder that persists ApiCallRecords as api_calls rows for one task.
 *
 * - seq starts at the task's current max(seq)+1 (looked up lazily when the
 *   first record arrives) and increments per record; every record maps to
 *   exactly one INSERT.
 * - Writes are serialized per recorder instance so seq order always matches
 *   call order.
 * - SAFETY: recording is best-effort — any capture/persist failure is logged
 *   via console.warn and swallowed, so it can never crash or alter task
 *   processing (the returned promise always resolves).
 */
export function createTaskRecorder(db: Db, taskId: string): Recorder {
  let nextSeq: number | null = null;
  let tail: Promise<void> = Promise.resolve();

  async function persist(call: ApiCallRecord): Promise<void> {
    if (nextSeq === null) {
      const rows = await db
        .select({ max: sql<number | null>`max(${apiCalls.seq})` })
        .from(apiCalls)
        .where(eq(apiCalls.taskId, taskId));
      nextSeq = (rows[0]?.max ?? 0) + 1;
    }
    const seq = nextSeq;
    nextSeq += 1;
    await db.insert(apiCalls).values({
      taskId,
      seq,
      phase: call.phase,
      method: call.method,
      url: call.url,
      requestHeaders: call.requestHeaders ?? null,
      requestBody: call.requestBody ?? null,
      responseStatus: call.responseStatus ?? null,
      responseHeaders: call.responseHeaders ?? null,
      responseBody: call.responseBody ?? null,
      durationMs: call.durationMs,
      dryRun: call.dryRun ?? false,
    });
  }

  return (call: ApiCallRecord): Promise<void> => {
    tail = tail.then(() =>
      persist(call).catch((error) => {
        console.warn(
          `[sower] api-call recorder failed for task ${taskId} (call not recorded):`,
          error,
        );
      }),
    );
    return tail;
  };
}
