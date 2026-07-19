'use server';

// Bulk discard for the Applications workspace's sticky select bar: takes the
// ticked task ids and calls the api's tolerant bulk endpoint
// (POST /tasks/discard — per-task skips never fail the batch). Same safety
// posture as the task-detail actions: only OUR api service is called
// (API_BASE_URL from deployment env, x-api-key auth), never a job platform.

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import type { ActionResult } from './tasks/[id]/actions';

const taskIdsSchema = z.array(z.string().uuid()).min(1);

/** The api's bulk endpoint caps a batch at 100 ids; larger selections chunk. */
const BATCH_SIZE = 100;

export async function discardTaskIds(ids: string[]): Promise<ActionResult> {
  const parsed = taskIdsSchema.safeParse(ids);
  if (!parsed.success) {
    return { ok: false, message: 'nothing (valid) selected.' };
  }

  const base = process.env.API_BASE_URL;
  const apiKey = process.env.INGEST_API_KEY;
  if (!base || !apiKey) {
    return {
      ok: false,
      message:
        'api service is not configured (API_BASE_URL / INGEST_API_KEY missing).',
    };
  }

  let failures = 0;
  for (let i = 0; i < parsed.data.length; i += BATCH_SIZE) {
    const taskIds = parsed.data.slice(i, i + BATCH_SIZE);
    try {
      const response = await fetch(`${base.replace(/\/$/, '')}/tasks/discard`, {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ taskIds }),
        cache: 'no-store',
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) failures += taskIds.length;
    } catch (err) {
      // Tolerated: the page re-renders from the DB either way; undiscarded
      // rows simply remain visible.
      console.warn('[sower dashboard] bulk discard batch failed:', err);
      failures += taskIds.length;
    }
  }

  revalidatePath('/');
  const n = parsed.data.length;
  if (failures === 0) {
    return { ok: true, message: `discarded ${n} task${n === 1 ? '' : 's'}.` };
  }
  return {
    ok: false,
    message: `some discards did not go through (${failures} of ${n}) — the list below reflects what actually happened.`,
  };
}
