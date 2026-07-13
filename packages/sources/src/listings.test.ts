import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchListings,
  filterListings,
  normalizeListing,
  type RawListing,
  SOURCES,
} from './listings.js';

/** Shaped like a real SimplifyJobs listings.json entry (terms[] schema). */
const simplifyRaw: RawListing = {
  source: 'Simplify',
  company_name: 'Cintas',
  id: '9c21bd21-2389-485f-a93b-e984e94a3712',
  title: 'IT Intern Middleware - Integrations',
  active: false,
  terms: ['Winter 2025'],
  date_updated: 1_763_114_253,
  url: 'https://careers.cintas.com/job/1342799800',
  is_visible: true,
};

/** Shaped like a real vanshb03 listings.json entry (season schema). */
const vanshRaw: RawListing = {
  date_updated: 1_749_260_792,
  url: 'https://ats.rippling.com/rippling/jobs/3fd9615a',
  active: true,
  company_name: 'Rippling',
  title: 'Frontend Software Engineer Intern',
  season: 'Summer',
  source: 'vanshb03',
  id: 'df70fa57-977b-4f31-832e-a0e57ed070b5',
  is_visible: true,
};

describe('normalizeListing', () => {
  it('normalizes the SimplifyJobs terms[] schema', () => {
    const normalized = normalizeListing(simplifyRaw, 'simplify-internships');
    expect(normalized).toEqual({
      id: '9c21bd21-2389-485f-a93b-e984e94a3712',
      url: 'https://careers.cintas.com/job/1342799800',
      company: 'Cintas',
      title: 'IT Intern Middleware - Integrations',
      active: false,
      visible: true,
      terms: ['Winter 2025'],
      term: 'Winter 2025',
      season: null,
      source: 'simplify-internships',
      date_updated: 1_763_114_253,
    });
  });

  it('normalizes the vanshb03 season schema (term falls back to season)', () => {
    const normalized = normalizeListing(vanshRaw, 'vanshb03');
    expect(normalized.term).toBe('Summer');
    expect(normalized.season).toBe('Summer');
    expect(normalized.company).toBe('Rippling');
    expect(normalized.active).toBe(true);
    expect(normalized.visible).toBe(true);
    expect(normalized.source).toBe('vanshb03');
  });

  it('handles listings with neither terms nor season (New-Grad schema)', () => {
    const normalized = normalizeListing({
      url: 'https://jobs.example.com/1',
      title: 'Software Engineer 1',
      active: true,
      is_visible: true,
    });
    expect(normalized.term).toBeNull();
    expect(normalized.season).toBeNull();
    expect(normalized.company).toBeNull();
    expect(normalized.date_updated).toBeNull();
  });

  it('prefers terms[0] over season when both are present', () => {
    const normalized = normalizeListing({
      url: 'https://jobs.example.com/2',
      title: 'Intern',
      terms: ['Summer 2027'],
      season: 'Summer',
    });
    expect(normalized.term).toBe('Summer 2027');
    expect(normalized.season).toBe('Summer');
  });

  it('maps is_visible: false to visible: false and missing to true', () => {
    const hidden = normalizeListing({ ...vanshRaw, is_visible: false });
    expect(hidden.visible).toBe(false);
    const { is_visible: _omitted, ...withoutVisible } = vanshRaw;
    expect(normalizeListing(withoutVisible).visible).toBe(true);
  });

  it('falls back: id to url, source to raw.source then "unknown"', () => {
    const bare = normalizeListing({
      url: 'https://jobs.example.com/3',
      title: 'Intern',
    });
    expect(bare.id).toBe('https://jobs.example.com/3');
    expect(bare.source).toBe('unknown');
    expect(normalizeListing(vanshRaw).source).toBe('vanshb03');
  });
});

describe('fetchListings', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('polls the live Summer 2027 internship source (vanshb03/Summer2027)', () => {
    expect(SOURCES.map((s) => s.name)).toEqual(['vanshb03']);
    for (const source of SOURCES) {
      expect(source.url).toMatch(/^https:\/\/raw\.githubusercontent\.com\//);
      expect(source.url).toContain('Summer2027');
    }
  });

  it('fetches every source, normalizes both schemas, and tags the source name', async () => {
    const bySourceUrl: Record<string, unknown> = {
      'https://a.example/listings.json': [vanshRaw],
      'https://b.example/listings.json': [
        simplifyRaw,
        { title: 'missing url — dropped' },
      ],
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        return new Response(JSON.stringify(bySourceUrl[url] ?? []), {
          status: 200,
        });
      }),
    );

    const listings = await fetchListings([
      { name: 'vansh-test', url: 'https://a.example/listings.json' },
      { name: 'simplify-test', url: 'https://b.example/listings.json' },
    ]);

    expect(listings).toHaveLength(2);
    expect(listings[0]?.source).toBe('vansh-test');
    expect(listings[0]?.term).toBe('Summer');
    expect(listings[1]?.source).toBe('simplify-test');
    expect(listings[1]?.term).toBe('Winter 2025');
  });

  it('skips a failing source but keeps the rest', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('broken')) throw new Error('boom');
        return new Response(JSON.stringify([simplifyRaw]), { status: 200 });
      }),
    );

    const listings = await fetchListings([
      { name: 'broken', url: 'https://broken.example/listings.json' },
      { name: 'ok', url: 'https://ok.example/listings.json' },
    ]);

    expect(listings).toHaveLength(1);
    expect(listings[0]?.source).toBe('ok');
  });

  it('returns [] when every source fails', async () => {
    // Closed localhost port: refused immediately, no external I/O.
    const listings = await fetchListings([
      { name: 'dead', url: 'http://127.0.0.1:1/nope.json' },
    ]);
    expect(listings).toEqual([]);
  });

  // Skipped by default: hits the network, so it is not suitable for CI.
  it.skip('fetches real listings from the default sources', async () => {
    const listings = await fetchListings();
    expect(listings.length).toBeGreaterThan(0);
    expect(listings[0]?.url).toMatch(/^https?:\/\//);
  });
});

describe('filterListings (normalized listings)', () => {
  it('matches a season word appearing in a requested term', () => {
    const summer = normalizeListing(vanshRaw, 'vanshb03'); // season "Summer"
    const winter = normalizeListing(
      { ...vanshRaw, id: 'winter', season: 'Winter' },
      'vanshb03',
    );

    const result = filterListings([summer, winter], {
      terms: ['Summer 2027'],
    });

    expect(result.map((l) => l.id)).toEqual([vanshRaw.id]);
  });

  it('matches terms[] schema listings by exact term intersection', () => {
    const wanted = normalizeListing(
      { ...simplifyRaw, id: 'wanted', terms: ['Summer 2027'], active: true },
      'simplify-internships',
    );
    const other = normalizeListing(simplifyRaw, 'simplify-internships'); // Winter 2025

    const result = filterListings([wanted, other], { terms: ['summer 2027'] });

    expect(result.map((l) => l.id)).toEqual(['wanted']);
  });

  it('also honors raw terms[] listings (pre-normalization shape)', () => {
    const raw = [
      { ...simplifyRaw, id: 'match', terms: ['Summer 2027'] },
      { ...simplifyRaw, id: 'other', terms: ['Fall 2026'] },
    ];

    const result = filterListings(raw, { terms: ['SUMMER 2027'] });

    expect(result.map((l) => l.id)).toEqual(['match']);
  });

  it('keeps listings with no term info at all', () => {
    const newGrad = normalizeListing(
      { url: 'https://jobs.example.com/ng', title: 'SWE 1' },
      'simplify-newgrad',
    );

    const result = filterListings([newGrad], { terms: ['Summer 2027'] });

    expect(result).toHaveLength(1);
  });

  it('activeOnly drops listings that are inactive OR invisible', () => {
    const ok = normalizeListing({ ...vanshRaw, id: 'ok' }, 'vanshb03');
    const inactive = normalizeListing(
      { ...vanshRaw, id: 'inactive', active: false },
      'vanshb03',
    );
    const hidden = normalizeListing(
      { ...vanshRaw, id: 'hidden', is_visible: false },
      'vanshb03',
    );

    const result = filterListings([ok, inactive, hidden], {
      terms: [],
      activeOnly: true,
    });

    expect(result.map((l) => l.id)).toEqual(['ok']);
  });

  it('sorts by date_updated descending and caps at max', () => {
    const listings = [
      normalizeListing({ ...vanshRaw, id: 'old', date_updated: 1 }),
      normalizeListing({ ...vanshRaw, id: 'new', date_updated: 3 }),
      normalizeListing({ ...vanshRaw, id: 'mid', date_updated: 2 }),
    ];

    const result = filterListings(listings, { terms: [], max: 2 });

    expect(result.map((l) => l.id)).toEqual(['new', 'mid']);
  });
});

describe('normalizeListing + filterListings — multi-term (review fix)', () => {
  it('preserves all terms so a non-first matching term still passes the filter', () => {
    const norm = normalizeListing(
      {
        url: 'https://x/1',
        title: 'Role',
        terms: ['Fall 2027', 'Summer 2027'],
      },
      'test',
    );
    expect(norm.terms).toEqual(['Fall 2027', 'Summer 2027']);
    const kept = filterListings([norm], { terms: ['Summer 2027'] });
    expect(kept).toHaveLength(1);
  });

  it('vanshb03 season still matches via season word', () => {
    const norm = normalizeListing(
      { url: 'https://x/2', title: 'Role', season: 'Summer' },
      'v',
    );
    const kept = filterListings([norm], { terms: ['Summer 2027'] });
    expect(kept).toHaveLength(1);
  });
});
