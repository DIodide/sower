/**
 * Source adapter for the Simplify "Summer Internships" listing repos.
 *
 * These repos publish a machine-readable listings.json on the `dev` branch,
 * which we fetch and minimally validate. Kept for backward compatibility:
 * new code should prefer fetchListings (listings.ts), which also normalizes
 * the vanshb03 `season` schema and tags each listing with its source name.
 */

import { fetchJsonArray, isMinimallyValidListing } from './listings.js';

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
    const data = await fetchJsonArray(url);
    if (data === null) continue;
    for (const item of data) {
      if (isMinimallyValidListing(item)) {
        listings.push(item as SimplifyListing);
      }
    }
  }
  return listings;
}
