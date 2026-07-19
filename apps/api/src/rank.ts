// Manual-rank math for the dashboard's "Waiting on you" section, shared by
// the reorder handler (drag-and-drop) and the meta handler (priority
// re-slot). Ranked rows sort by sort_rank asc ahead of the unranked block
// (priority desc / recency), so composing the two orders means a priority
// change on a RANKED row must move it WITHIN the ranked block — never clear
// its rank (which would drop it below every ranked row: the demotion bug).

import { applicationTasks } from '@sower/db';
import { type SQL, sql } from 'drizzle-orm';

/** Base spacing between assigned sort ranks: leaves ~10 halvings of headroom
 *  between any two neighbors before a resequence is needed. */
export const RANK_GAP = 1024;

/** A midpoint closer than this to either neighbor is a collision — the
 *  affected ranks are resequenced to RANK_GAP-spaced integers first. */
export const RANK_EPSILON = 1e-6;

/**
 * Rank for a row dropped between neighbors: the midpoint of the two, or one
 * RANK_GAP beyond the lone neighbor at either end. At least one neighbor
 * rank must be provided (both undefined would mean "nowhere").
 */
export function midpointRank(
  aboveRank: number | undefined,
  belowRank: number | undefined,
): number {
  if (aboveRank !== undefined && belowRank !== undefined) {
    return (aboveRank + belowRank) / 2;
  }
  if (aboveRank !== undefined) {
    return aboveRank + RANK_GAP;
  }
  return (belowRank as number) - RANK_GAP;
}

/** True when two neighbor ranks are too close for a distinct midpoint. */
export function ranksCollide(
  aboveRank: number | undefined,
  belowRank: number | undefined,
): boolean {
  return (
    aboveRank !== undefined &&
    belowRank !== undefined &&
    Math.abs(aboveRank - belowRank) < 2 * RANK_EPSILON
  );
}

/**
 * B2 (option A): the slot a RANKED row re-occupies when its priority
 * changes. `others` is the section's other ranked rows in rank order
 * (top-down); the row bubbles in the direction of the change — UP past
 * ranked rows a raise now outranks, DOWN past ranked rows a lower no longer
 * outranks — and stops at the first row it doesn't, so equal priorities
 * keep their relative order. Returns the new insertion index into `others`
 * (0..others.length), or null when the row shouldn't move (the rank is then
 * left untouched).
 */
export function reslotIndex(
  others: readonly { sortRank: number; priority: number }[],
  currentRank: number,
  oldPriority: number,
  newPriority: number,
): number | null {
  // The row's current slot: how many other ranked rows sit above it.
  let index = 0;
  while (index < others.length) {
    const other = others[index];
    if (other === undefined || other.sortRank >= currentRank) break;
    index += 1;
  }
  let next = index;
  if (newPriority > oldPriority) {
    // Raise: bubble UP past rows the new priority outranks.
    while (next > 0) {
      const above = others[next - 1];
      if (above === undefined || above.priority >= newPriority) break;
      next -= 1;
    }
  } else if (newPriority < oldPriority) {
    // Lower: bubble DOWN past rows that now outrank it.
    while (next < others.length) {
      const below = others[next];
      if (below === undefined || below.priority <= newPriority) break;
      next += 1;
    }
  }
  return next === index ? null : next;
}

/**
 * SQL-conditional rank assignment: writes `rank` ONLY if the row still has a
 * manual rank when the UPDATE executes — the ranked/unranked decision lives
 * in the statement itself, not in an earlier read, so a rank cleared
 * concurrently (the section's "clear manual order", a racing debounce) stays
 * cleared instead of being resurrected by a stale re-slot.
 */
export function rankedCaseSql(rank: number): SQL {
  return sql`case when ${applicationTasks.sortRank} is null then null else ${rank} end`;
}
