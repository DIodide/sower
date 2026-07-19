import { describe, expect, it } from 'vitest';
import { pickDeadline, toDateInputValue } from './deadline';

const USER = new Date('2026-08-01T00:00:00.000Z');
const POSTING = new Date('2026-07-30T00:00:00.000Z');

describe('pickDeadline (display precedence)', () => {
  it("the user's own due date wins over the posting deadline", () => {
    const picked = pickDeadline(USER, POSTING);
    expect(picked?.kind).toBe('user');
    expect(picked?.date.toISOString()).toBe('2026-08-01T00:00:00.000Z');
  });

  it('falls back to the posting deadline when no user date is set', () => {
    const picked = pickDeadline(null, POSTING);
    expect(picked?.kind).toBe('posting');
    expect(picked?.date.toISOString()).toBe('2026-07-30T00:00:00.000Z');
  });

  it('returns null when neither date exists', () => {
    expect(pickDeadline(null, null)).toBeNull();
    expect(pickDeadline(undefined, undefined)).toBeNull();
  });

  it('treats invalid dates as absent (a bad user date still falls back)', () => {
    const picked = pickDeadline(new Date('nonsense'), POSTING);
    expect(picked?.kind).toBe('posting');
    expect(pickDeadline(new Date('nonsense'), null)).toBeNull();
  });

  it('accepts ISO strings as well as Date objects', () => {
    const picked = pickDeadline('2026-08-01', null);
    expect(picked?.kind).toBe('user');
    expect(picked?.date.toISOString()).toBe('2026-08-01T00:00:00.000Z');
  });
});

describe('toDateInputValue', () => {
  it('renders the UTC calendar date for the native date input', () => {
    expect(toDateInputValue(USER)).toBe('2026-08-01');
    expect(toDateInputValue('2026-07-30T00:00:00.000Z')).toBe('2026-07-30');
  });

  it('null/invalid in, null out', () => {
    expect(toDateInputValue(null)).toBeNull();
    expect(toDateInputValue(undefined)).toBeNull();
    expect(toDateInputValue(new Date('nonsense'))).toBeNull();
  });
});
