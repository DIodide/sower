import { StringChunk } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
  midpointRank,
  RANK_EPSILON,
  RANK_GAP,
  ranksCollide,
  waitingOrderBy,
} from './rank.js';

describe('waitingOrderBy (the waiting-section display order)', () => {
  it('priority desc → unranked-first → rank asc → arrival desc, in that exact key order', () => {
    // The contract behind THE APPLE CASE: priority desc is always primary
    // (a ranked Low row can never sort above a Normal row), and within a
    // tier the unranked block (created_at desc — a fresh ingest surfaces at
    // the TOP of its tier) sits above the ranked block (sort_rank asc).
    // Must mirror apps/dashboard/app/page.tsx (SQL) and
    // apps/dashboard/lib/reorder.ts compareWaiting (client) exactly.
    const texts = waitingOrderBy().map((fragment) =>
      fragment.queryChunks
        .map((chunk) =>
          chunk instanceof StringChunk ? chunk.value.join('') : '?',
        )
        .join(''),
    );
    expect(texts).toEqual([
      '? desc',
      'case when ? is null then 0 else 1 end',
      '? asc',
      '? desc nulls last',
    ]);
  });
});

describe('midpointRank / ranksCollide', () => {
  it('midpoint between two neighbors, gap beyond a lone end neighbor', () => {
    expect(midpointRank(1024, 2048)).toBe(1536);
    expect(midpointRank(2048, undefined)).toBe(2048 + RANK_GAP);
    expect(midpointRank(undefined, 1024)).toBe(1024 - RANK_GAP);
  });

  it('collision detection uses the shared epsilon', () => {
    expect(ranksCollide(1000, 1000 + RANK_EPSILON)).toBe(true);
    expect(ranksCollide(1024, 2048)).toBe(false);
    expect(ranksCollide(undefined, 1024)).toBe(false);
  });
});
