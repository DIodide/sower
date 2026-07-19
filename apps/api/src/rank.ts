// Manual-rank math for the dashboard's "Waiting on you" section, shared by
// the reorder handler (drag-and-drop) and mirrored by the dashboard page
// query and its client comparator (apps/dashboard/lib/reorder.ts). The
// display order (waitingOrderBy below) is:
//
//   priority desc                 — tiers: Highest → High → Normal → Low,
//                                   ALWAYS the primary sort
//   unranked before ranked        — within a tier: new/untriaged demands
//                                   attention above the hand-placed block
//   created_at desc               — orders the unranked block: new ingests
//                                   surface at the top of their tier
//   sort_rank asc                 — orders the ranked block: the user's order
//
// A rank is therefore only meaningful WITHIN a priority tier: a drag
// computes midpoints against the destination tier's ranked rows (and a drop
// straddling a tier boundary adopts the destination tier's priority), while
// an explicit priority change simply clears the rank — the row re-enters
// its new tier as its newest unranked (top-of-tier) item.

import { applicationTasks } from '@sower/db';
import { type SQL, sql } from 'drizzle-orm';

/** Base spacing between assigned sort ranks: leaves ~10 halvings of headroom
 *  between any two neighbors before a resequence is needed. */
export const RANK_GAP = 1024;

/** A midpoint closer than this to either neighbor is a collision — the
 *  affected ranks are resequenced to RANK_GAP-spaced integers first. */
export const RANK_EPSILON = 1e-6;

/**
 * The waiting section's display order, in ORDER BY form. MUST stay in
 * lock-step with the dashboard page query (apps/dashboard/app/page.tsx) and
 * the client comparator (apps/dashboard/lib/reorder.ts compareWaiting) —
 * the reorder handler reads the section through this exact order so the
 * neighbor ids a drop reports mean the same positions the user saw.
 */
export function waitingOrderBy(): SQL[] {
  return [
    // Priority desc is ALWAYS primary: a Low row can never sort above a
    // Normal row, whatever ranks say.
    sql`${applicationTasks.priority} desc`,
    // Unranked first within the tier (new/untriaged over hand-placed).
    sql`case when ${applicationTasks.sortRank} is null then 0 else 1 end`,
    // The ranked block by the user's order. Nulls never mix into this key —
    // the case key above already split the groups — so no nulls clause.
    sql`${applicationTasks.sortRank} asc`,
    // Arrival time orders the unranked block, newest first. created_at is
    // immutable, so background processing can never shuffle the block
    // (updatedAt would). `nulls last`: a plain desc would sort a null
    // created_at FIRST — an unknown arrival must read oldest, not newest.
    sql`${applicationTasks.createdAt} desc nulls last`,
  ];
}

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
