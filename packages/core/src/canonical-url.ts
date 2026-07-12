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
