/**
 * VERIFIED greenhouse tenant probe for custom-domain postings.
 *
 * A `gh_jid` URL on a company's own domain (akunacapital.com/careers/…)
 * names the greenhouse JOB but not the board tenant, so the boards API is
 * unreachable and ingest parks the task. The tenant is usually a guessable
 * transform of the hostname, and the boards API confirms a guess for free:
 * GET /v1/boards/<candidate>/jobs/<jobId> answers 200 with that job's `id`
 * only when the candidate board really owns the job. This module generates
 * hostname-derived candidates and probes each — a tenant is only ever
 * returned VERIFIED (200 + matching id), never guessed.
 *
 * SSRF: every probe targets the FIXED greenhouse API origin below; only the
 * path segments (candidate token + job id) vary, so no user-controlled host
 * is ever fetched.
 */

const GREENHOUSE_BOARDS_API = 'https://boards-api.greenhouse.io/v1/boards';
const PROBE_TIMEOUT_MS = 6_000;
const MAX_CANDIDATES = 5;

/** Hostname prefixes that never carry the company identity. */
const STRIPPED_PREFIXES = new Set(['www', 'careers', 'jobs', 'apply']);

/** Second-level labels of two-part public suffixes (acme.co.uk → acme). */
const SECOND_LEVEL_SUFFIXES = new Set([
  'co',
  'com',
  'net',
  'org',
  'ac',
  'gov',
  'edu',
]);

/** Corporate-noise suffixes a board token usually drops (acme-inc → acme). */
const CORPORATE_SUFFIXES = ['-inc', '-io', 'hq'];

/**
 * Lower-priority: a joined compound name minus its trailing generic word
 * (akunacapital → akuna). Tried LAST — the full label is the better guess.
 */
const TRAILING_WORD_RE = /-?(?:capital|labs|technologies|tech)$/;

/**
 * Board-tenant candidate tokens derived from a page URL's hostname, most
 * specific first, deduped, capped at MAX_CANDIDATES. Empty when the URL is
 * unparseable. Pure — the probe below decides which (if any) is real.
 */
export function greenhouseTenantCandidates(pageUrl: string): string[] {
  let hostname: string;
  try {
    hostname = new URL(pageUrl).hostname.toLowerCase();
  } catch {
    return [];
  }

  const labels = hostname.split('.').filter((label) => label.length > 0);
  while (labels.length > 2 && STRIPPED_PREFIXES.has(labels[0] ?? '')) {
    labels.shift();
  }

  // The registrable label: the one just left of the public suffix
  // (akunacapital.com → akunacapital, acme.co.uk → acme).
  let label: string | undefined;
  const last = labels.at(-1);
  const secondLast = labels.at(-2);
  if (
    labels.length >= 3 &&
    last !== undefined &&
    last.length === 2 &&
    secondLast !== undefined &&
    SECOND_LEVEL_SUFFIXES.has(secondLast)
  ) {
    label = labels.at(-3);
  } else if (labels.length >= 2) {
    label = secondLast;
  } else {
    label = labels[0];
  }
  if (!label) {
    return [];
  }

  const candidates: string[] = [label];
  for (const suffix of CORPORATE_SUFFIXES) {
    if (label.endsWith(suffix)) {
      const stripped = label.slice(0, -suffix.length);
      if (stripped.length > 0) {
        candidates.push(stripped);
      }
    }
  }
  const withoutTrailingWord = label.replace(TRAILING_WORD_RE, '');
  if (withoutTrailingWord.length > 0 && withoutTrailingWord !== label) {
    candidates.push(withoutTrailingWord);
  }

  return [...new Set(candidates)].slice(0, MAX_CANDIDATES);
}

/**
 * Probe one candidate against the fixed boards API. A hit REQUIRES a 200
 * whose JSON `id` equals the job id (stringified compare) — a wrong-job 200
 * (or any error/non-JSON body) is a miss, never a throw.
 */
async function probeCandidate(
  candidate: string,
  jobId: string,
): Promise<boolean> {
  try {
    const response = await fetch(
      `${GREENHOUSE_BOARDS_API}/${encodeURIComponent(candidate)}/jobs/${encodeURIComponent(jobId)}`,
      { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) },
    );
    if (response.status !== 200) {
      return false;
    }
    const payload = (await response.json()) as { id?: unknown };
    return String(payload?.id) === String(jobId);
  } catch {
    return false; // network error, timeout, non-JSON body — a miss
  }
}

/**
 * Derive the VERIFIED greenhouse board tenant for a custom-domain posting:
 * probe each hostname-derived candidate sequentially (first hit wins) and
 * return it, or null when none verifies. Never throws.
 */
export async function deriveGreenhouseTenant(
  pageUrl: string,
  jobId: string,
): Promise<string | null> {
  for (const candidate of greenhouseTenantCandidates(pageUrl)) {
    if (await probeCandidate(candidate, jobId)) {
      return candidate;
    }
  }
  return null;
}
