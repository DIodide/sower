/**
 * Source adapter for the Simplify "Summer Internships" listing repos.
 *
 * These repos publish a machine-readable listings.json on the `dev` branch,
 * which we fetch, minimally validate, and filter down to the terms we care
 * about (e.g. "Summer 2027").
 */

export const SIMPLIFY_LISTING_URLS = [
  'https://raw.githubusercontent.com/vanshb03/Summer2027-Internships/dev/.github/scripts/listings.json',
  'https://raw.githubusercontent.com/SimplifyJobs/Summer2026-Internships/dev/.github/scripts/listings.json',
];

export interface SimplifyListing {
  id: string;
  company_name: string;
  title: string;
  url: string;
  terms: string[];
  active: boolean;
  /** Unix epoch seconds. */
  date_updated: number;
  source: string;
}

export interface FilterListingsOptions {
  /** Keep listings whose `terms` intersect these (case-insensitive). */
  terms: string[];
  /** When true, drop listings whose `active` is explicitly false. */
  activeOnly?: boolean;
  /** Cap the number of returned listings (applied after sorting). */
  max?: number;
}

const FETCH_TIMEOUT_MS = 15_000;

/**
 * Fetch listings from each URL (15s timeout apiece), tolerating individual
 * failures: a URL that errors, times out, or returns malformed data is
 * skipped with a console.warn and the rest are still returned.
 */
export async function fetchSimplifyListings(
  urls: string[] = SIMPLIFY_LISTING_URLS,
): Promise<SimplifyListing[]> {
  const listings: SimplifyListing[] = [];
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) {
        console.warn(`[sources] fetch failed for ${url}: HTTP ${res.status}`);
        continue;
      }
      const data: unknown = await res.json();
      if (!Array.isArray(data)) {
        console.warn(`[sources] unexpected payload from ${url}: not an array`);
        continue;
      }
      for (const item of data) {
        if (isMinimallyValidListing(item)) {
          listings.push(item);
        }
      }
    } catch (err) {
      console.warn(`[sources] fetch failed for ${url}:`, err);
    }
  }
  return listings;
}

/** Minimal validation: a listing must at least have a url and a title. */
function isMinimallyValidListing(value: unknown): value is SimplifyListing {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.url === 'string' &&
    record.url.length > 0 &&
    typeof record.title === 'string' &&
    record.title.length > 0
  );
}

/**
 * Filter listings by term intersection (case-insensitive; only applied when
 * a listing carries term info) and, optionally, active status. Results are
 * sorted by date_updated descending and capped at opts.max when provided.
 * The input array is not mutated.
 */
export function filterListings(
  listings: SimplifyListing[],
  opts: FilterListingsOptions,
): SimplifyListing[] {
  const wantedTerms = opts.terms.map((term) => term.toLowerCase());

  const filtered = listings.filter((listing) => {
    if (opts.activeOnly && listing.active === false) return false;
    if (
      wantedTerms.length > 0 &&
      Array.isArray(listing.terms) &&
      listing.terms.length > 0
    ) {
      const intersects = listing.terms.some((term) =>
        wantedTerms.includes(term.toLowerCase()),
      );
      if (!intersects) return false;
    }
    return true;
  });

  filtered.sort((a, b) => (b.date_updated ?? 0) - (a.date_updated ?? 0));

  return typeof opts.max === 'number' ? filtered.slice(0, opts.max) : filtered;
}
