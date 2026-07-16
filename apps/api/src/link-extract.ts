import { canonicalizeUrl } from '@sower/core';
import { detectPlatform } from '@sower/platforms';

/**
 * Link extraction + a guarded page fetch for the Discord ingest path. All
 * fetches here are of USER-SUPPLIED URLs, so they go through `assertSafeFetchTarget`
 * on every redirect hop — the api runs on Cloud Run, whose metadata endpoint
 * (169.254.169.254) is a classic SSRF target.
 */

const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const FETCH_TIMEOUT_MS = 12_000;
const MAX_PAGE_BYTES = 2_000_000;
const MAX_REDIRECTS = 5;

// URLs in free text: stop at whitespace and the delimiters that commonly abut a
// pasted/markdown/angle-bracketed link. Trailing punctuation is trimmed after.
const URL_RE = /https?:\/\/[^\s<>"'()\]]+/gi;
const HREF_RE = /href\s*=\s*["']([^"']+)["']/gi;

/** Redirect-shim hosts → the query param(s) that carry the real destination. */
const SHIM_HOST_PARAMS: Record<string, string[]> = {
  'l.instagram.com': ['u'],
  'l.facebook.com': ['u'],
  'lm.facebook.com': ['u'],
  'www.google.com': ['q', 'url'],
  'google.com': ['q', 'url'],
  'out.reddit.com': ['url'],
};

const MAX_SHIM_DEPTH = 3;

/**
 * Unwrap known redirect-shim links that carry the real destination in a query
 * param (l.instagram.com/?u=…, l.facebook.com/l.php?u=…, google.com/url?q=…).
 * A plain fetch of these lands on an interstitial/home page, losing the target,
 * so decode the param up front. Opaque short-links (t.co, lnkd.in, bit.ly) carry
 * no embedded target and are left to resolveUrl's redirect-follow. Recurses (a
 * shim can wrap a shim); returns the input unchanged when it's not a shim.
 */
export function unwrapRedirectShim(url: string, depth = 0): string {
  if (depth >= MAX_SHIM_DEPTH) {
    return url;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  const paramNames = SHIM_HOST_PARAMS[parsed.hostname.toLowerCase()];
  if (!paramNames) {
    return url;
  }
  for (const name of paramNames) {
    const target = parsed.searchParams.get(name); // URL-decodes the value
    // Only a URL-valued param is a shim target — e.g. a real Google Careers
    // URL has ?q=ai+catalyst (a search term, not a URL) and must pass through.
    if (target && /^https?:\/\//i.test(target)) {
      return unwrapRedirectShim(target, depth + 1);
    }
  }
  return url;
}

/** Workday returns platform:'workday' for ANY tenant host; only a /job/ or
 *  /details/ path is an actual posting we can discover. Everything else
 *  (login/careers landing) falls through to directory-expand-or-record.
 *  Lives here (not discord-ingest) so ingestJob can consult it without an
 *  import cycle; refreshIngestReply classifies a stored job the same way. */
export function isIngestableJobUrl(platform: string, url: string): boolean {
  if (platform !== 'workday') return true;
  try {
    return /\/(job|details)\//i.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

/** Extract distinct http(s) URLs from message text (trailing punctuation trimmed). */
export function extractUrlsFromText(text: string): string[] {
  const matches = text.match(URL_RE) ?? [];
  const cleaned = matches.map((url) => url.replace(/[.,;:!?]+$/, ''));
  return [...new Set(cleaned)];
}

/** Extract absolute anchor hrefs from HTML, resolving relative URLs against base. */
export function extractAnchorHrefs(html: string, baseUrl: string): string[] {
  const out = new Set<string>();
  HREF_RE.lastIndex = 0;
  let match: RegExpExecArray | null = HREF_RE.exec(html);
  while (match !== null) {
    const raw = match[1];
    match = HREF_RE.exec(html);
    if (!raw) {
      continue;
    }
    try {
      const abs = new URL(raw, baseUrl).toString();
      if (abs.startsWith('http://') || abs.startsWith('https://')) {
        out.add(abs);
      }
    } catch {
      // malformed href — skip
    }
  }
  return [...out];
}

function isPrivateIpLiteral(host: string): boolean {
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true; // link-local incl. metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    return false;
  }
  if (host === '::1' || host === '::') return true;
  // IPv6 ULA (fc00::/7) + link-local (fe80::/10) literals
  return (
    host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80')
  );
}

/** SSRF guard: http(s) only; reject localhost / internal / private-IP hosts. */
export function assertSafeFetchTarget(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`invalid url: ${url}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`refusing non-http(s) url: ${parsed.protocol}`);
  }
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (
    host === 'localhost' ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    isPrivateIpLiteral(host)
  ) {
    throw new Error(`refusing internal/private host: ${host}`);
  }
}

/** Fetch following redirects manually, re-checking the SSRF guard on each hop. */
async function guardedFetch(url: string): Promise<Response | null> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    assertSafeFetchTarget(current);
    const response = await fetch(current, {
      redirect: 'manual',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { 'user-agent': BROWSER_UA, accept: 'text/html' },
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) {
        return response;
      }
      current = new URL(location, current).toString();
      continue;
    }
    return response;
  }
  return null; // too many redirects
}

export interface FetchedPage {
  /** Page HTML, capped at MAX_PAGE_BYTES. */
  html: string;
  /** The URL the HTML actually came from (after any redirects). */
  url: string;
}

/**
 * Fetch a page's HTML once through the SSRF-guarded fetch, so callers can run
 * BOTH the greenhouse-embed sniff and directory link extraction over the same
 * body. Best-effort: any fetch failure, non-OK status, or non-HTML response
 * yields null (the caller then records the URL itself as a single unknown job).
 */
export async function fetchPageHtml(url: string): Promise<FetchedPage | null> {
  let response: Response | null;
  try {
    response = await guardedFetch(url);
  } catch {
    return null;
  }
  if (!response?.ok) {
    return null;
  }
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('html')) {
    return null;
  }
  const html = (await response.text()).slice(0, MAX_PAGE_BYTES);
  return { html, url: response.url || url };
}

/**
 * The anchor hrefs in HTML that point to a SUPPORTED job platform
 * (detectPlatform recognizes the host — greenhouse/ashby/lever/workday).
 */
export function extractJobLinks(html: string, baseUrl: string): string[] {
  const hrefs = extractAnchorHrefs(html, baseUrl);
  const jobLinks = hrefs.filter(
    (href) => detectPlatform(canonicalizeUrl(href)).platform !== 'unknown',
  );
  return [...new Set(jobLinks)];
}

/** fetchPageHtml + extractJobLinks in one step (fetch-and-extract callers). */
export async function fetchJobLinks(url: string): Promise<string[]> {
  const page = await fetchPageHtml(url);
  return page ? extractJobLinks(page.html, page.url) : [];
}

/** A greenhouse job identified inside a custom-domain page's HTML. */
export interface GreenhouseSniff {
  tenant: string;
  jobId: string;
}

/** Greenhouse board hosts as they appear inside page HTML/JS. */
const GH_HOST = String.raw`(?:job-)?boards(?:\.eu)?\.greenhouse\.io`;
/** Classic application-form embed: /embed/job_app?for=<tenant>&token=<id>. */
const GH_EMBED_RE = new RegExp(
  `${GH_HOST}/embed/job_app\\?([^"'\\s<>\\\\]+)`,
  'i',
);
/** Direct board posting link: /<tenant>/jobs/<id>. */
const GH_BOARD_JOB_RE = new RegExp(
  `${GH_HOST}/([A-Za-z0-9][A-Za-z0-9_-]*)/jobs/(\\d+)`,
  'gi',
);
/** Any board link naming a tenant (board root, job_board embed, …). */
const GH_BOARD_TENANT_RE = new RegExp(
  `${GH_HOST}/(?:embed/job(?:_app|_board)\\?[^"'\\s<>\\\\]*?\\bfor=|)([A-Za-z0-9][A-Za-z0-9_-]*)`,
  'gi',
);

/** Board-host path segments that are never a tenant (board assets/embeds). */
const GH_NON_TENANT_SEGMENTS = new Set([
  'embed',
  'assets',
  'static',
  'js',
  'css',
  'images',
]);

/** First tenant named by ANY greenhouse board reference in the HTML. */
function sniffBoardTenant(source: string): string | null {
  GH_BOARD_TENANT_RE.lastIndex = 0;
  for (const match of source.matchAll(GH_BOARD_TENANT_RE)) {
    const tenant = match[1];
    if (tenant && !GH_NON_TENANT_SEGMENTS.has(tenant.toLowerCase())) {
      return tenant;
    }
  }
  return null;
}

/**
 * Sniff a greenhouse tenant + job id out of a CUSTOM-DOMAIN page (Stripe,
 * Databricks, … host their postings on their own domain, so the URL alone
 * detects as unknown). Markers, strongest first:
 * - a `gh_jid=<id>` param on the page URL (pins THIS page's job id) combined
 *   with any board reference in the HTML that names the tenant
 * - the classic embed `boards.greenhouse.io/embed/job_app?for=<tenant>&token=<id>`
 * - exactly ONE distinct `(job-)boards.greenhouse.io/<tenant>/jobs/<id>` link
 *   (several distinct ones mean the page is a directory — left to directory
 *   expansion, which already recognizes those links)
 * Pure (no fetch) so it is testable; returns null when no job is identifiable.
 */
export function sniffGreenhouseJob(
  html: string,
  pageUrl: string,
): GreenhouseSniff | null {
  // Board URLs are routinely entity-escaped in attributes (&amp;) or
  // JSON-escaped in inline scripts (&); normalize before matching.
  const source = html.replace(/&amp;/gi, '&').replace(/\\u0026/gi, '&');

  let embedTenant: string | null = null;
  let embedJobId: string | null = null;
  const embed = GH_EMBED_RE.exec(source);
  if (embed?.[1]) {
    const params = new URLSearchParams(embed[1]);
    embedTenant = params.get('for');
    embedJobId = params.get('token');
  }

  GH_BOARD_JOB_RE.lastIndex = 0;
  const boardJobs = new Map<string, GreenhouseSniff>();
  for (const match of source.matchAll(GH_BOARD_JOB_RE)) {
    const tenant = match[1];
    const jobId = match[2];
    if (tenant && jobId && tenant.toLowerCase() !== 'embed') {
      boardJobs.set(`${tenant.toLowerCase()}/${jobId}`, { tenant, jobId });
    }
  }
  const distinctBoardJobs = [...boardJobs.values()];

  let ghJid: string | null = null;
  try {
    ghJid = new URL(pageUrl).searchParams.get('gh_jid');
  } catch {
    // unparseable page URL — the HTML markers alone must carry the sniff
  }
  if (ghJid) {
    const tenant =
      embedTenant ?? distinctBoardJobs[0]?.tenant ?? sniffBoardTenant(source);
    if (tenant) {
      return { tenant, jobId: ghJid };
    }
  }

  if (embedTenant && embedJobId) {
    return { tenant: embedTenant, jobId: embedJobId };
  }

  const only = distinctBoardJobs.length === 1 ? distinctBoardJobs[0] : null;
  return only ?? null;
}
