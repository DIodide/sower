import { describe, expect, it } from 'vitest';
import { deadlineFromIsoDate, extractDeadline } from './deadline.js';

describe('extractDeadline', () => {
  describe('trigger phrases (each explicit pattern)', () => {
    it("parses 'apply by <date>'", () => {
      expect(
        extractDeadline('Please apply by July 30, 2026 to be considered'),
      ).toBe('2026-07-30T00:00:00.000Z');
    });

    it("parses 'application deadline: <date>'", () => {
      expect(extractDeadline('Application deadline: 2026-08-15')).toBe(
        '2026-08-15T00:00:00.000Z',
      );
    });

    it("parses 'application deadline is <date>' (no colon)", () => {
      expect(
        extractDeadline('The application deadline is September 1, 2026.'),
      ).toBe('2026-09-01T00:00:00.000Z');
    });

    it("parses 'applications close on <date>'", () => {
      expect(
        extractDeadline('Applications close on October 3, 2026 at noon'),
      ).toBe('2026-10-03T00:00:00.000Z');
    });

    it("parses 'applications are due by <date>'", () => {
      expect(
        extractDeadline(
          'Applications are due by 15 August 2026, no exceptions',
        ),
      ).toBe('2026-08-15T00:00:00.000Z');
    });

    it("parses 'application due <date>'", () => {
      expect(extractDeadline('Application due Nov 12, 2026')).toBe(
        '2026-11-12T00:00:00.000Z',
      );
    });

    it("parses 'deadline to apply: <date>'", () => {
      expect(extractDeadline('Deadline to apply: Dec 1, 2026')).toBe(
        '2026-12-01T00:00:00.000Z',
      );
    });

    it("parses 'deadline to apply is <date>'", () => {
      expect(extractDeadline('deadline to apply is 2026-02-28')).toBe(
        '2026-02-28T00:00:00.000Z',
      );
    });
  });

  describe('date forms', () => {
    it('parses every month name (full and abbreviated)', () => {
      const cases: Array<[string, string]> = [
        ['January 5, 2026', '2026-01-05'],
        ['february 5, 2026', '2026-02-05'],
        ['Mar 5, 2026', '2026-03-05'],
        ['April 5 2026', '2026-04-05'],
        ['May 5, 2026', '2026-05-05'],
        ['Jun 5, 2026', '2026-06-05'],
        ['July 5, 2026', '2026-07-05'],
        ['Aug 5, 2026', '2026-08-05'],
        ['September 5, 2026', '2026-09-05'],
        ['Sept 5, 2026', '2026-09-05'],
        ['Oct 5, 2026', '2026-10-05'],
        ['November 5, 2026', '2026-11-05'],
        ['Dec 5, 2026', '2026-12-05'],
      ];
      for (const [date, iso] of cases) {
        expect(extractDeadline(`apply by ${date}`)).toBe(
          `${iso}T00:00:00.000Z`,
        );
      }
    });

    it('parses day-first dates with ordinals ("30th of June, 2026")', () => {
      expect(extractDeadline('apply by 30th of June, 2026')).toBe(
        '2026-06-30T00:00:00.000Z',
      );
      expect(extractDeadline('applications close 1 March 2027')).toBe(
        '2027-03-01T00:00:00.000Z',
      );
    });

    it('parses ordinal month-first dates ("June 3rd, 2026")', () => {
      expect(extractDeadline('apply by June 3rd, 2026')).toBe(
        '2026-06-03T00:00:00.000Z',
      );
    });

    it('parses ISO dates with 1-digit month/day', () => {
      expect(extractDeadline('application deadline: 2026-7-4')).toBe(
        '2026-07-04T00:00:00.000Z',
      );
    });

    it('is case-insensitive and tolerates a trailing period on the month', () => {
      expect(extractDeadline('APPLY BY SEPT. 15, 2026')).toBe(
        '2026-09-15T00:00:00.000Z',
      );
    });

    it('extracts from surrounding markdown/prose and takes the first match', () => {
      const text = [
        '## About the role',
        'We are hiring interns.',
        '**Apply by January 9, 2027.** Late applications: deadline to apply: March 1, 2027 for waitlist.',
      ].join('\n\n');
      expect(extractDeadline(text)).toBe('2027-01-09T00:00:00.000Z');
    });
  });

  describe('conservative rejections (parsed, never inferred)', () => {
    it('returns null when no explicit deadline phrase exists', () => {
      expect(
        extractDeadline('Posted on July 30, 2026. Start date: 2027-06-01.'),
      ).toBeNull();
      expect(extractDeadline('')).toBeNull();
      expect(extractDeadline('Apply today!')).toBeNull();
    });

    it('rejects ambiguous numeric-only dates (3/4/25)', () => {
      expect(extractDeadline('apply by 3/4/25')).toBeNull();
      expect(extractDeadline('application deadline: 03/04/2025')).toBeNull();
      expect(extractDeadline('applications close on 12-01-2026')).toBeNull();
    });

    it('rejects month-name dates without a year (would force a guess)', () => {
      expect(extractDeadline('apply by July 30')).toBeNull();
      expect(extractDeadline('applications close on Dec 1')).toBeNull();
    });

    it('rejects impossible calendar dates instead of rolling them over', () => {
      expect(extractDeadline('application deadline: 2026-13-01')).toBeNull();
      expect(extractDeadline('apply by February 30, 2026')).toBeNull();
      expect(extractDeadline('application deadline: 2026-02-30')).toBeNull();
    });

    it('rejects a bare date right after an unrelated word', () => {
      // "apply" alone (no "by") is not an explicit deadline statement.
      expect(extractDeadline('apply January 9, 2027')).toBeNull();
    });
  });

  it("still returns past dates (lapsed deadlines are the caller's call)", () => {
    expect(extractDeadline('apply by January 15, 2019')).toBe(
      '2019-01-15T00:00:00.000Z',
    );
  });
});

describe('deadlineFromIsoDate', () => {
  it('normalizes a plain YYYY-MM-DD to UTC midnight', () => {
    expect(deadlineFromIsoDate('2026-08-01')).toBe('2026-08-01T00:00:00.000Z');
  });

  it('keeps the named date of a full ISO timestamp', () => {
    expect(deadlineFromIsoDate('2026-08-01T23:59:00-04:00')).toBe(
      '2026-08-01T00:00:00.000Z',
    );
  });

  it("accepts workday's offset-suffixed date form", () => {
    expect(deadlineFromIsoDate('2026-08-01-07:00')).toBe(
      '2026-08-01T00:00:00.000Z',
    );
  });

  it('trims surrounding whitespace', () => {
    expect(deadlineFromIsoDate(' 2026-08-01 ')).toBe(
      '2026-08-01T00:00:00.000Z',
    );
  });

  it('returns null for non-date values and impossible dates', () => {
    expect(deadlineFromIsoDate('')).toBeNull();
    expect(deadlineFromIsoDate('soon')).toBeNull();
    expect(deadlineFromIsoDate('08/01/2026')).toBeNull();
    expect(deadlineFromIsoDate('2026-13-01')).toBeNull();
    expect(deadlineFromIsoDate('2026-02-30')).toBeNull();
    // A date embedded in trailing junk is not a clean value.
    expect(deadlineFromIsoDate('2026-08-01x')).toBeNull();
  });
});
