import { describe, expect, it } from 'vitest';
import { moveToIndex, neighborIds } from './reorder';

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
