'use server';

// Bulk discard for the Queue page: reads every checked `taskIds` checkbox
// from the page-wide form and calls the api's tolerant bulk endpoint
// (POST /tasks/discard — per-task skips never fail the batch). Same safety
// posture as the task-detail actions: only OUR api service is called
// (API_BASE_URL from deployment env, x-api-key auth), never a job platform.

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

const taskIdsSchema = z.array(z.string().uuid()).min(1);

/** The api's bulk endpoint caps a batch at 100 ids; larger selections chunk. */
const BATCH_SIZE = 100;

export async function discardTasks(formData: FormData): Promise<void> {
  const raw = formData
    .getAll('taskIds')
    .filter((value): value is string => typeof value === 'string');
  const parsed = taskIdsSchema.safeParse(raw);
  if (!parsed.success) {
    // Nothing (valid) selected — nothing to do.
    return;
  }

  const base = process.env.API_BASE_URL;
  const apiKey = process.env.INGEST_API_KEY;
  if (!base || !apiKey) {
    console.warn(
      '[sower dashboard] bulk discard skipped: API_BASE_URL / INGEST_API_KEY missing',
    );
    return;
  }

  for (let i = 0; i < parsed.data.length; i += BATCH_SIZE) {
    const taskIds = parsed.data.slice(i, i + BATCH_SIZE);
    try {
      await fetch(`${base.replace(/\/$/, '')}/tasks/discard`, {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ taskIds }),
        cache: 'no-store',
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      // Tolerated: the page re-renders from the DB either way; undiscarded
      // rows simply remain visible.
      console.warn('[sower dashboard] bulk discard batch failed:', err);
    }
  }

  revalidatePath('/queue');
  revalidatePath('/');
}
