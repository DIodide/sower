import { StringChunk } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
  midpointRank,
  RANK_EPSILON,
  RANK_GAP,
  rankedCaseSql,
  ranksCollide,
  reslotIndex,
} from './rank.js';

describe('reslotIndex (priority re-slot within the ranked block)', () => {
  it('THE DEMOTION CASE: raising a bottom-ranked row past equal-priority rows above moves it to the top, never below them', () => {
    // Section: A(1024, normal), B(2048, normal), moved row ranked 3072.
    const others = [
      { sortRank: 1024, priority: 0 },
      { sortRank: 2048, priority: 0 },
    ];
    // Raise normal -> highest: outranks both -> slot 0 (top of the section).
    expect(reslotIndex(others, 3072, 0, 2)).toBe(0);
  });

  it('a raise stops below a ranked row of equal or higher priority (relative order kept)', () => {
    const others = [
      { sortRank: 1024, priority: 2 },
      { sortRank: 2048, priority: 0 },
    ];
    // normal -> high: passes B (normal) but not A (highest) -> between them.
    expect(reslotIndex(others, 3072, 0, 1)).toBe(1);
  });

  it('a raise stops below an EQUAL-priority row (stable among peers)', () => {
    const others = [
      { sortRank: 1024, priority: 1 },
      { sortRank: 2048, priority: 0 },
    ];
    expect(reslotIndex(others, 3072, 0, 1)).toBe(1);
  });

  it('a lower moves the row DOWN past rows that now outrank it', () => {
    // Moved row is ranked at the top (rank 512), lowered highest -> normal.
    const others = [
      { sortRank: 1024, priority: 1 },
      { sortRank: 2048, priority: 0 },
    ];
    // Passes A (high > normal), stops above B (normal <= normal).
    expect(reslotIndex(others, 512, 2, 0)).toBe(1);
  });

  it('a lower can land at the bottom of the ranked block', () => {
    const others = [
      { sortRank: 1024, priority: 2 },
      { sortRank: 2048, priority: 1 },
    ];
    expect(reslotIndex(others, 512, 2, -1)).toBe(2);
  });

  it('returns null when the row should not move', () => {
    const others = [
      { sortRank: 1024, priority: 2 },
      { sortRank: 2048, priority: 1 },
    ];
    // Unchanged priority: no direction, no move.
    expect(reslotIndex(others, 3072, 0, 0)).toBeNull();
    // Raise blocked immediately by a higher-priority row directly above.
    expect(reslotIndex(others, 3072, 0, 1)).toBeNull();
    // Already at the top; a raise has nowhere to go.
    expect(reslotIndex(others, 512, 1, 2)).toBeNull();
    // No other ranked rows at all: the lone rank keeps its position.
    expect(reslotIndex([], 1024, 0, 2)).toBeNull();
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

describe('rankedCaseSql (the race guard)', () => {
  it('is conditional in the SQL itself: NULL stays NULL, otherwise the new rank', () => {
    const chunks = rankedCaseSql(1536).queryChunks;
    const text = chunks
      .map((chunk) =>
        chunk instanceof StringChunk ? chunk.value.join('') : '?',
      )
      .join('');
    // The guard lives in the UPDATE, not in an earlier read: a concurrently
    // cleared rank can never be resurrected by a stale re-slot write.
    expect(text).toBe('case when ? is null then null else ? end');
  });

  it('binds the computed rank as a parameter', () => {
    const chunks = rankedCaseSql(1536).queryChunks;
    // drizzle embeds primitive template values directly as chunks (they are
    // parameterized at query-build time).
    expect(chunks.filter((chunk) => typeof chunk === 'number')).toEqual([1536]);
  });
});
