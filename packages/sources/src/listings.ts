/**
 * Generalized listing-source pipeline.
 *
 * Several GitHub repos publish a machine-readable listings.json on their
 * `dev` branch. Two raw schemas exist in the wild:
 *
 * - SimplifyJobs repos: term info as `terms: string[]` (e.g. ["Summer 2026"]);
 *   the New-Grad repo carries no term info at all.
 * - vanshb03's Summer2027 repo: term info as a single `season` word
 *   (e.g. "Summer") plus `is_visible`.
 *
 * `fetchListings` pulls every source, `normalizeListing` unifies the two
 * schemas into `NormalizedListing`, and `filterListings` filters either raw
 * or normalized listings by term/season and active status.
 */

export interface Source {
  name: string;
  url: string;
}

/** Default listing sources (all verified to serve listings.json on `dev`). */
export const SOURCES: Source[] = [
  {
    name: 'vanshb03',
    url: 'https://raw.githubusercontent.com/vanshb03/Summer2027-Internships/dev/.github/scripts/listings.json',
  },
  {
    name: 'simplify-internships',
    url: 'https://raw.githubusercontent.com/SimplifyJobs/Summer2026-Internships/dev/.github/scripts/listings.json',
  },
  {
    name: 'simplify-newgrad',
    url: 'https://raw.githubusercontent.com/SimplifyJobs/New-Grad-Positions/dev/.github/scripts/listings.json',
  },
];

/** Union of the fields the known raw listing schemas may carry. */
export interface RawListing {
  id?: string;
  url: string;
  title: string;
  company_name?: string;
  active?: boolean;
  is_visible?: boolean;
  /** SimplifyJobs schema: e.g. ["Summer 2026"]. */
  terms?: string[];
  /** vanshb03 schema: a single season word, e.g. "Summer". */
  season?: string;
  /** Unix epoch seconds. */
  date_updated?: number;
  source?: string;
}

/** One unified shape regardless of which raw schema a listing came from. */
export interface NormalizedListing {
  id: string;
  url: string;
  company: string | null;
  title: string;
  active: boolean;
  visible: boolean;
  /** All terms[] entries (SimplifyJobs), so multi-term listings match on any. */
  terms: string[];
  /** First terms[] entry, else the season word, else null (for display). */
  term: string | null;
  season: string | null;
  source: string;
  /** Unix epoch seconds; kept so filterListings can sort by recency. */
  date_updated: number | null;
}

const FETCH_TIMEOUT_MS = 15_000;

/**
 * Fetch a JSON array (15s timeout), tolerating failure: an error, timeout,
 * non-2xx status, or non-array payload yields null after a console.warn so
 * callers can skip the source and continue.
 */
export async function fetchJsonArray(url: string): Promise<unknown[] | null> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn(`[sources] fetch failed for ${url}: HTTP ${res.status}`);
      return null;
    }
    const data: unknown = await res.json();
    if (!Array.isArray(data)) {
      console.warn(`[sources] unexpected payload from ${url}: not an array`);
      return null;
    }
    return data;
  } catch (err) {
    console.warn(`[sources] fetch failed for ${url}:`, err);
    return null;
  }
}

/** Minimal validation: a listing must at least have a url and a title. */
export function isMinimallyValidListing(value: unknown): value is RawListing {
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
 * Unify a raw listing (either schema) into a NormalizedListing. `source`
 * overrides the raw item's own source field (fetchListings passes the
 * Source.name so listings are attributable to the repo they came from).
 */
export function normalizeListing(
  raw: RawListing,
  source?: string,
): NormalizedListing {
  const terms = Array.isArray(raw.terms)
    ? raw.terms.filter((t): t is string => typeof t === 'string')
    : [];
  const season =
    typeof raw.season === 'string' && raw.season.length > 0 ? raw.season : null;
  return {
    id: raw.id ?? raw.url,
    url: raw.url,
    company: raw.company_name ?? null,
    title: raw.title,
    active: raw.active !== false,
    visible: raw.is_visible !== false,
    terms,
    term: terms[0] ?? season,
    season,
    source: source ?? raw.source ?? 'unknown',
    date_updated:
      typeof raw.date_updated === 'number' ? raw.date_updated : null,
  };
}

/**
 * Fetch and normalize listings from each source, tolerating individual
 * failures: a source that errors, times out, or returns malformed data is
 * skipped with a console.warn and the rest are still returned.
 */
export async function fetchListings(
  sources: Source[] = SOURCES,
): Promise<NormalizedListing[]> {
  const listings: NormalizedListing[] = [];
  for (const source of sources) {
    const data = await fetchJsonArray(source.url);
    if (data === null) continue;
    for (const item of data) {
      if (isMinimallyValidListing(item)) {
        listings.push(normalizeListing(item, source.name));
      }
    }
  }
  return listings;
}

/**
 * The minimal shape filterListings needs; both SimplifyListing (raw) and
 * NormalizedListing satisfy it.
 */
export interface FilterableListing {
  terms?: string[] | null;
  term?: string | null;
  season?: string | null;
  active?: boolean;
  visible?: boolean;
  date_updated?: number | null;
}

export interface FilterListingsOptions {
  /** Keep listings whose term/season info matches these (case-insensitive). */
  terms: string[];
  /** When true, drop listings whose active or visible is explicitly false. */
  activeOnly?: boolean;
  /** Cap the number of returned listings (applied after sorting). */
  max?: number;
}

/**
 * Filter listings by term (case-insensitive). A listing matches when its
 * terms[] (or normalized single term) intersects the wanted terms, OR when
 * its season word appears in a wanted term (season "Summer" matches a
 * requested "Summer 2027"). Listings carrying no term info at all are kept.
 * activeOnly drops listings whose active or visible is explicitly false.
 * Results are sorted by date_updated descending and capped at opts.max when
 * provided. The input array is not mutated.
 */
export function filterListings<T extends FilterableListing>(
  listings: T[],
  opts: FilterListingsOptions,
): T[] {
  const wantedTerms = opts.terms.map((term) => term.toLowerCase());

  const filtered = listings.filter((listing) => {
    if (
      opts.activeOnly &&
      (listing.active === false || listing.visible === false)
    ) {
      return false;
    }

    const listingTerms =
      Array.isArray(listing.terms) && listing.terms.length > 0
        ? listing.terms
        : listing.term
          ? [listing.term]
          : [];
    const season = listing.season ? listing.season.toLowerCase() : null;

    if (wantedTerms.length > 0 && (listingTerms.length > 0 || season)) {
      const intersects = listingTerms.some((term) =>
        wantedTerms.includes(term.toLowerCase()),
      );
      const seasonMatches =
        season !== null &&
        wantedTerms.some((wanted) => wanted.includes(season));
      if (!intersects && !seasonMatches) return false;
    }
    return true;
  });

  filtered.sort((a, b) => (b.date_updated ?? 0) - (a.date_updated ?? 0));

  return typeof opts.max === 'number' ? filtered.slice(0, opts.max) : filtered;
}
