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

/** What the api's bulk endpoint reports: honest per-task results. */
const bulkDiscardResponseSchema = z.object({
  ok: z.boolean().optional(),
  discarded: z.number(),
  skipped: z.array(z.object({ id: z.string(), reason: z.string() })),
});

export interface BulkDiscardResult extends ActionResult {
  /** Ids this call actually discarded — the exact set an Undo restores. */
  discardedIds: string[];
}

/** The api's bulk endpoint caps a batch at 100 ids; larger selections chunk. */
const BATCH_SIZE = 100;

export async function discardTaskIds(
  ids: string[],
): Promise<BulkDiscardResult> {
  const parsed = taskIdsSchema.safeParse(ids);
  if (!parsed.success) {
    return {
      ok: false,
      message: 'nothing (valid) selected.',
      discardedIds: [],
    };
  }

  const base = process.env.API_BASE_URL;
  const apiKey = process.env.INGEST_API_KEY;
  if (!base || !apiKey) {
    return {
      ok: false,
      message:
        'api service is not configured (API_BASE_URL / INGEST_API_KEY missing).',
      discardedIds: [],
    };
  }

  // Honest tallies: `discarded` is the api's own count — the message never
  // claims more than it. Skips (already sent, duplicates, already discarded)
  // and outright batch failures are reported separately.
  let discarded = 0;
  let skipped = 0;
  let failed = 0;
  const discardedIds: string[] = [];
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
      if (!response.ok) {
        failed += taskIds.length;
        continue;
      }
      const body = bulkDiscardResponseSchema.parse(await response.json());
      discarded += body.discarded;
      skipped += body.skipped.length;
      const skippedIds = new Set(body.skipped.map((s) => s.id));
      discardedIds.push(...taskIds.filter((id) => !skippedIds.has(id)));
    } catch (err) {
      // Tolerated: the page re-renders from the DB either way; undiscarded
      // rows simply remain visible.
      console.warn('[sower dashboard] bulk discard batch failed:', err);
      failed += taskIds.length;
    }
  }

  revalidatePath('/');
  const parts = [`Discarded ${discarded}`];
  if (skipped > 0) {
    parts.push(`skipped ${skipped} (already sent or duplicates)`);
  }
  if (failed > 0) parts.push(`${failed} failed — still in the list`);
  return {
    ok: failed === 0 && (discarded > 0 || skipped > 0),
    message: parts.join(' · '),
    discardedIds,
  };
}
