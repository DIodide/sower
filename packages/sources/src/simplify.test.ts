import { describe, expect, it } from 'vitest';
import { filterListings } from './listings.js';
import {
  fetchSimplifyListings,
  SIMPLIFY_LISTING_URLS,
  type SimplifyListing,
} from './simplify.js';

let seq = 0;

function makeListing(
  overrides: Partial<SimplifyListing> = {},
): SimplifyListing {
  seq += 1;
  return {
    id: `listing-${seq}`,
    company_name: 'Acme Corp',
    title: 'Software Engineering Intern',
    url: `https://jobs.example.com/${seq}`,
    terms: ['Summer 2027'],
    active: true,
    date_updated: 1_750_000_000,
    source: 'Simplify',
    ...overrides,
  };
}

describe('filterListings', () => {
  it('keeps listings whose terms intersect the wanted terms (case-insensitive)', () => {
    const match = makeListing({ id: 'match', terms: ['summer 2027'] });
    const otherTerm = makeListing({ id: 'other', terms: ['Fall 2026'] });
    const multiTerm = makeListing({
      id: 'multi',
      terms: ['Fall 2026', 'SUMMER 2027'],
    });

    const result = filterListings([match, otherTerm, multiTerm], {
      terms: ['Summer 2027'],
    });

    expect(result.map((l) => l.id).sort()).toEqual(['match', 'multi']);
  });

  it('keeps listings without term info when filtering by terms', () => {
    const noTerms = makeListing({ id: 'no-terms', terms: [] });
    const wrongTerm = makeListing({ id: 'wrong', terms: ['Fall 2026'] });

    const result = filterListings([noTerms, wrongTerm], {
      terms: ['Summer 2027'],
    });

    expect(result.map((l) => l.id)).toEqual(['no-terms']);
  });

  it('keeps everything when no wanted terms are given', () => {
    const listings = [
      makeListing({ terms: ['Fall 2026'] }),
      makeListing({ terms: ['Summer 2027'] }),
    ];

    const result = filterListings(listings, { terms: [] });

    expect(result).toHaveLength(2);
  });

  it('drops inactive listings only when activeOnly is set', () => {
    const active = makeListing({ id: 'active', active: true });
    const inactive = makeListing({ id: 'inactive', active: false });

    const withActiveOnly = filterListings([active, inactive], {
      terms: ['Summer 2027'],
      activeOnly: true,
    });
    expect(withActiveOnly.map((l) => l.id)).toEqual(['active']);

    const withoutActiveOnly = filterListings([active, inactive], {
      terms: ['Summer 2027'],
    });
    expect(withoutActiveOnly.map((l) => l.id).sort()).toEqual([
      'active',
      'inactive',
    ]);
  });

  it('sorts by date_updated descending', () => {
    const oldest = makeListing({ id: 'oldest', date_updated: 100 });
    const newest = makeListing({ id: 'newest', date_updated: 300 });
    const middle = makeListing({ id: 'middle', date_updated: 200 });

    const result = filterListings([oldest, newest, middle], {
      terms: ['Summer 2027'],
    });

    expect(result.map((l) => l.id)).toEqual(['newest', 'middle', 'oldest']);
  });

  it('caps results at max after sorting', () => {
    const listings = [
      makeListing({ id: 'a', date_updated: 1 }),
      makeListing({ id: 'b', date_updated: 3 }),
      makeListing({ id: 'c', date_updated: 2 }),
    ];

    const result = filterListings(listings, {
      terms: ['Summer 2027'],
      max: 2,
    });

    expect(result.map((l) => l.id)).toEqual(['b', 'c']);
  });

  it('does not mutate the input array', () => {
    const listings = [
      makeListing({ id: 'a', date_updated: 1 }),
      makeListing({ id: 'b', date_updated: 2 }),
    ];
    const originalOrder = listings.map((l) => l.id);

    filterListings(listings, { terms: ['Summer 2027'], max: 1 });

    expect(listings.map((l) => l.id)).toEqual(originalOrder);
  });
});

describe('fetchSimplifyListings', () => {
  it('exposes the two default listing URLs', () => {
    expect(SIMPLIFY_LISTING_URLS).toHaveLength(2);
    for (const url of SIMPLIFY_LISTING_URLS) {
      expect(url).toMatch(/^https:\/\/raw\.githubusercontent\.com\//);
    }
  });

  it('returns [] when every source fails', async () => {
    // Closed localhost port: refused immediately, no external I/O.
    const result = await fetchSimplifyListings([
      'http://127.0.0.1:1/nope.json',
    ]);
    expect(result).toEqual([]);
  });

  // Skipped by default: hits the network, so it is not suitable for CI.
  it.skip('fetches real listings from the Simplify repos', async () => {
    const listings = await fetchSimplifyListings();
    expect(listings.length).toBeGreaterThan(0);
    expect(listings[0]?.url).toMatch(/^https?:\/\//);
  });
});
