import { describe, expect, it } from 'vitest';
import {
  compareWaiting,
  dropPriority,
  moveToIndex,
  neighborIds,
  type WaitingSortKey,
} from './reorder';

interface FixtureRow extends WaitingSortKey {
  id: string;
}

/** Day-granular arrival times: DAY(0) is a week-old row, DAY(7) today's. */
const DAY = (n: number) => n * 86_400_000;

const sortedIds = (rows: FixtureRow[]) =>
  [...rows].sort(compareWaiting).map((row) => row.id);

describe('compareWaiting (the "Waiting on you" order contract)', () => {
  it('THE APPLE CASE: a fresh unranked ingest lands at the TOP of its tier — above week-old ranked rows — not at the bottom of the list', () => {
    const rows: FixtureRow[] = [
      { id: 'old-ranked-1', priority: 0, sortRank: 1024, createdAtMs: DAY(0) },
      { id: 'old-ranked-2', priority: 0, sortRank: 2048, createdAtMs: DAY(1) },
      { id: 'apple', priority: 0, sortRank: null, createdAtMs: DAY(7) },
    ];
    expect(sortedIds(rows)).toEqual(['apple', 'old-ranked-1', 'old-ranked-2']);
  });

  it('…but above NOTHING of a higher tier: priority desc is always primary', () => {
    const rows: FixtureRow[] = [
      { id: 'apple', priority: 0, sortRank: null, createdAtMs: DAY(7) },
      { id: 'high-ranked', priority: 1, sortRank: 1024, createdAtMs: DAY(0) },
      { id: 'high-new', priority: 1, sortRank: null, createdAtMs: DAY(6) },
    ];
    expect(sortedIds(rows)).toEqual(['high-new', 'high-ranked', 'apple']);
  });

  it('a ranked Low row can NEVER sort above a Normal row (the old global-rank bug)', () => {
    const rows: FixtureRow[] = [
      { id: 'low-ranked', priority: -1, sortRank: 1, createdAtMs: DAY(6) },
      { id: 'normal-old', priority: 0, sortRank: null, createdAtMs: DAY(0) },
      { id: 'normal-ranked', priority: 0, sortRank: 512, createdAtMs: DAY(1) },
    ];
    expect(sortedIds(rows)).toEqual([
      'normal-old',
      'normal-ranked',
      'low-ranked',
    ]);
  });

  it('the unranked block orders by ARRIVAL, newest first', () => {
    const rows: FixtureRow[] = [
      { id: 'monday', priority: 0, sortRank: null, createdAtMs: DAY(1) },
      { id: 'friday', priority: 0, sortRank: null, createdAtMs: DAY(5) },
      { id: 'wednesday', priority: 0, sortRank: null, createdAtMs: DAY(3) },
    ];
    expect(sortedIds(rows)).toEqual(['friday', 'wednesday', 'monday']);
  });

  it('the ranked block keeps the hand-made order (sort_rank asc), whatever the arrival times', () => {
    const rows: FixtureRow[] = [
      { id: 'second', priority: 0, sortRank: 2048, createdAtMs: DAY(6) },
      { id: 'first', priority: 0, sortRank: 1024, createdAtMs: DAY(0) },
      { id: 'third', priority: 0, sortRank: 3072, createdAtMs: DAY(3) },
    ];
    expect(sortedIds(rows)).toEqual(['first', 'second', 'third']);
  });

  it('full mix: tiers desc, then unranked-by-arrival over ranked-by-rank inside each tier', () => {
    const rows: FixtureRow[] = [
      { id: 'n-ranked', priority: 0, sortRank: 100, createdAtMs: DAY(6) },
      { id: 'low-new', priority: -1, sortRank: null, createdAtMs: DAY(7) },
      { id: 'n-new', priority: 0, sortRank: null, createdAtMs: DAY(5) },
      { id: 'hi-ranked', priority: 2, sortRank: 9000, createdAtMs: DAY(0) },
      { id: 'n-newer', priority: 0, sortRank: null, createdAtMs: DAY(6) },
      { id: 'hi-new', priority: 2, sortRank: null, createdAtMs: DAY(2) },
    ];
    expect(sortedIds(rows)).toEqual([
      'hi-new',
      'hi-ranked',
      'n-newer',
      'n-new',
      'n-ranked',
      'low-new',
    ]);
  });
});

describe('dropPriority (the destination-tier rule for drops)', () => {
  it('between two same-tier rows: that tier', () => {
    expect(dropPriority(0, 0)).toBe(0);
    expect(dropPriority(2, 2)).toBe(2);
  });

  it('at a tier boundary: the tier of the row it was dropped DIRECTLY below', () => {
    expect(dropPriority(1, 0)).toBe(1);
    expect(dropPriority(0, -1)).toBe(0);
  });

  it('at the very top of the list: the tier of the row it now heads', () => {
    expect(dropPriority(undefined, 2)).toBe(2);
  });

  it('at the very bottom of the list: the tier of the row above', () => {
    expect(dropPriority(-1, undefined)).toBe(-1);
  });

  it('no neighbors at all (a one-row list): undefined — nothing to adopt', () => {
    expect(dropPriority(undefined, undefined)).toBeUndefined();
  });
});

const LIST = ['a', 'b', 'c', 'd'];

describe('moveToIndex (insertion-slot semantics)', () => {
  it('moves a row up: dropping c in the slot above b', () => {
    expect(moveToIndex(LIST, 2, 1)).toEqual(['a', 'c', 'b', 'd']);
  });

  it('moves a row down: dropping a in the slot below c', () => {
    expect(moveToIndex(LIST, 0, 3)).toEqual(['b', 'c', 'a', 'd']);
  });

  it('moves to the very top and the very bottom', () => {
    expect(moveToIndex(LIST, 2, 0)).toEqual(['c', 'a', 'b', 'd']);
    expect(moveToIndex(LIST, 0, 4)).toEqual(['b', 'c', 'd', 'a']);
  });

  it('returns the SAME array for no-op drops (both adjacent slots)', () => {
    expect(moveToIndex(LIST, 1, 1)).toBe(LIST);
    expect(moveToIndex(LIST, 1, 2)).toBe(LIST);
  });

  it('ignores an out-of-range source index', () => {
    expect(moveToIndex(LIST, -1, 0)).toBe(LIST);
    expect(moveToIndex(LIST, 4, 0)).toBe(LIST);
  });
});

describe('neighborIds', () => {
  const rows = LIST.map((id) => ({ id }));

  it('reports both neighbors for a middle row', () => {
    expect(neighborIds(rows, 'b')).toEqual({
      beforeTaskId: 'a',
      afterTaskId: 'c',
    });
  });

  it('omits the missing side at the ends (never null)', () => {
    expect(neighborIds(rows, 'a')).toEqual({ afterTaskId: 'b' });
    expect(neighborIds(rows, 'd')).toEqual({ beforeTaskId: 'c' });
  });

  it('returns {} for an id not in the list', () => {
    expect(neighborIds(rows, 'zz')).toEqual({});
  });
});
