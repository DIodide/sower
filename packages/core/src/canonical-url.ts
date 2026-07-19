/**
 * Query params that are always dropped (tracking noise). Listed explicitly so
 * the intent is auditable, even though the allowlist below would drop them
 * anyway.
 */
const TRACKING_PARAMS = new Set(['ref', 'src']);
const TRACKING_PARAM_PREFIX = 'utm_';

/** The only query params allowed to survive canonicalization. */
const ALLOWED_PARAMS = new Set(['gh_jid']);

function isTrackingParam(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.startsWith(TRACKING_PARAM_PREFIX) || TRACKING_PARAMS.has(lower);
}

/**
 * Canonicalizes a job URL for deduplication:
 * - lowercases the host
 * - strips the hash fragment
 * - strips trailing slashes from the path
 * - drops utm_* / ref / src tracking params explicitly
 * - drops every other query param except `gh_jid` (Greenhouse job id)
 *
 * Throws a TypeError (from `new URL`) on input that is not a valid URL.
 */
export function canonicalizeUrl(url: string): string {
  const parsed = new URL(url);

  const host = parsed.host.toLowerCase();

  let pathname = parsed.pathname;
  while (pathname.endsWith('/')) {
    pathname = pathname.slice(0, -1);
  }

  const kept = new URLSearchParams();
  for (const [name, value] of parsed.searchParams) {
    if (isTrackingParam(name)) continue;
    if (!ALLOWED_PARAMS.has(name)) continue;
    if (!kept.has(name)) kept.set(name, value);
  }

  const query = kept.size > 0 ? `?${kept.toString()}` : '';
  return `${parsed.protocol}//${host}${pathname}${query}`;
}

/**
 * Params stripped from the STORED job URL (not just the canonical dedupe
 * form): pure tracking/referral noise that should never be persisted or
 * re-opened — e.g. `gh_src` is Greenhouse's referral-source tag (a pasted
 * board link carried `gh_src=zero2sudo`, someone else's referral code).
 * Conservative on purpose: only params that are never functional.
 */
const STORED_URL_TRACKING = new Set([
  'gh_src',
  'ref',
  'src',
  'fbclid',
  'gclid',
  'mc_cid',
  'mc_eid',
]);

/**
 * Removes tracking/referral params (utm_*, gh_src, ref, src, click ids) from
 * a URL while leaving every other part untouched — unlike `canonicalizeUrl`
 * it preserves path case, trailing slashes, fragments, and functional params.
 * Safe for the URL that gets stored and re-opened. Returns the input
 * unchanged if it does not parse.
 */
export function stripTrackingParams(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  const toDelete: string[] = [];
  for (const name of parsed.searchParams.keys()) {
    const lower = name.toLowerCase();
    if (
      lower.startsWith(TRACKING_PARAM_PREFIX) ||
      STORED_URL_TRACKING.has(lower)
    ) {
      toDelete.push(name);
    }
  }
  if (toDelete.length === 0) return url;
  for (const name of toDelete) {
    parsed.searchParams.delete(name);
  }
  return parsed.toString();
}
