import { describe, expect, it } from 'vitest';
import { compareRecent, parseSortMode } from './sort';

describe('parseSortMode', () => {
  it("only 'recent' leaves the default priority order", () => {
    expect(parseSortMode('recent')).toBe('recent');
    expect(parseSortMode('priority')).toBe('priority');
    expect(parseSortMode('newest')).toBe('priority');
    expect(parseSortMode(null)).toBe('priority');
    expect(parseSortMode(undefined)).toBe('priority');
  });
});

describe('compareRecent', () => {
  it('orders newest arrival first regardless of priority or rank', () => {
    const rows = [
      { id: 'old-high', createdAtMs: 100, priority: 2, sortRank: 1 },
      { id: 'new-low', createdAtMs: 300, priority: -1, sortRank: null },
      { id: 'mid', createdAtMs: 200, priority: 0, sortRank: null },
      // Unknown created_at (0) sinks to the bottom.
      { id: 'unknown', createdAtMs: 0, priority: 2, sortRank: null },
    ];
    expect([...rows].sort(compareRecent).map((r) => r.id)).toEqual([
      'new-low',
      'mid',
      'old-high',
      'unknown',
    ]);
  });
});
