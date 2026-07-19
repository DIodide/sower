// Pure list mechanics for the "Waiting on you" drag-and-drop (app/
// ordered-list): the section's order contract (compareWaiting), the
// destination-tier rule for drops (dropPriority), moving a row to an
// insertion slot, and reading off the moved row's new neighbors. The api
// owns the rank math — the client only ever reports WHICH rows ended up
// adjacent (and mirrors the tier rule for its optimistic priority + toast).

import type { TaskPriority } from '@sower/core';

/** Sort inputs for compareWaiting — the three columns the order reads. */
export interface WaitingSortKey {
  priority: TaskPriority;
  /** Manual rank; null = unranked (new/untriaged — demands attention). */
  sortRank: number | null;
  /** Arrival time (created_at, epoch ms) — immutable, so background
   *  processing can never shuffle the unranked block. */
  createdAtMs: number;
}

/**
 * THE "Waiting on you" order. MUST stay in lock-step with the page query's
 * ORDER BY (app/page.tsx) and the api's waitingOrderBy (apps/api/src/
 * rank.ts):
 *
 *   1. priority desc — ALWAYS primary: a Low row can never sort above a
 *      Normal row, whatever ranks say.
 *   2. within a tier, unranked before ranked — a fresh ingest surfaces at
 *      the TOP of its tier, above the hand-placed block.
 *   3. unranked rows by arrival, newest first; ranked rows by sort_rank asc
 *      (arrival breaks the never-in-practice rank tie).
 */
export function compareWaiting(a: WaitingSortKey, b: WaitingSortKey): number {
  if (a.priority !== b.priority) return b.priority - a.priority;
  const aRanked = a.sortRank === null ? 0 : 1;
  const bRanked = b.sortRank === null ? 0 : 1;
  if (aRanked !== bRanked) return aRanked - bRanked;
  if (a.sortRank !== null && b.sortRank !== null && a.sortRank !== b.sortRank) {
    return a.sortRank - b.sortRank;
  }
  return b.createdAtMs - a.createdAtMs;
}

/**
 * The tier a dropped row adopts, from its new neighbors' priorities: the
 * tier both neighbors share — or, at a tier boundary, the tier of the
 * neighbor the row was dropped DIRECTLY below; at the very top of the list
 * (no row above) the tier of the row it now heads. Mirrors the api's
 * derivation in POST /tasks/:id/reorder exactly, so the optimistic priority
 * and the "Moved to High" toast always agree with the server. undefined
 * only when the row has no neighbors at all (a one-row list — no move).
 */
export function dropPriority(
  above: TaskPriority | undefined,
  below: TaskPriority | undefined,
): TaskPriority | undefined {
  return above ?? below;
}

/**
 * Neighbor ids for POST /tasks/:id/reorder: beforeTaskId is the row
 * immediately ABOVE `id` in the new order, afterTaskId immediately BELOW.
 * A key is omitted (not null) at the list's ends.
 */
export interface ReorderNeighbors {
  beforeTaskId?: string;
  afterTaskId?: string;
}

/**
 * Move the item at `from` to insertion slot `insertAt` (a gap index 0..n
 * computed against the list WITH the item still in place, i.e. what a drop
 * between rows means visually). Returns the SAME array reference when the
 * move is a no-op, so callers can skip a pointless write.
 */
export function moveToIndex<T>(
  list: readonly T[],
  from: number,
  insertAt: number,
): readonly T[] {
  if (from < 0 || from >= list.length) return list;
  const target = Math.max(
    0,
    Math.min(list.length - 1, insertAt > from ? insertAt - 1 : insertAt),
  );
  if (target === from) return list;
  const next = [...list];
  const [moved] = next.splice(from, 1);
  next.splice(target, 0, moved as T);
  return next;
}

/** The moved row's neighbors in the (new) order — what the api needs. */
export function neighborIds(
  list: readonly { id: string }[],
  id: string,
): ReorderNeighbors {
  const index = list.findIndex((row) => row.id === id);
  if (index === -1) return {};
  const beforeTaskId = list[index - 1]?.id;
  const afterTaskId = list[index + 1]?.id;
  return {
    ...(beforeTaskId !== undefined ? { beforeTaskId } : {}),
    ...(afterTaskId !== undefined ? { afterTaskId } : {}),
  };
}
