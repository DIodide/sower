/**
 * Listing-link filtering: turn the anchors collected from a RENDERED page
 * (collectAnchors in page-functions.ts) into candidate individual-job links.
 * This is what rescues JS-rendered SPA listing pages (the databricks case):
 * the raw-HTML directory expansion at ingest sees no anchors there, but the
 * headless render does — and when the page turns out to be a listing rather
 * than a single posting, these links are what the caller ingests.
 *
 * Kept: anchors whose href detectPlatform recognizes (greenhouse/lever/
 * ashby/workday hosts, incl. ?gh_jid= custom-domain greenhouse), PLUS
 * same-registrable-domain links matching job-detail path patterns — incl.
 * careers-path slugs ending in a long numeric ATS id (the databricks
 * `…/careers/university-recruiting/phd-…-intern-7011263002` shape).
 * Excluded: pagination/filter chrome (nav/footer anchors are already
 * dropped in-page), links back to the listing itself, duplicates. Capped
 * at 50.
 */
import { canonicalizeUrl } from '@sower/core';
import { detectPlatform } from '@sower/platforms';
import type { AnchorCandidate } from './page-functions.js';

/**
 * Fewer qualifying links than this and the page is NOT a listing. Two is
 * enough: a small team page rendering just two job links is still a listing
 * worth expanding (databricks's university page rendered only three), while
 * ONE link is not — a single job anchor is indistinguishable from a posting
 * page linking to itself or a sibling.
 */
export const LISTING_LINKS_MIN = 2;
/** Hard cap — mirrors the api's directory-expansion cap. */
export const MAX_LISTING_LINKS = 50;

/** Link text that marks pagination/filter chrome, never an individual job. */
const PAGINATION_TEXT_RE =
  /^(?:next|prev(?:ious)?|first|last|more|load more|show more|see more|view all|all jobs|filters?|sort(?: by)?|clear(?: all)?|reset|[«»‹›<>]|\d+)$/i;

/** Path segments that follow /jobs/ etc. on LISTING views, not job details. */
const NON_DETAIL_FOLLOWERS = new Set([
  'search',
  'all',
  'index',
  'list',
  'results',
  'openings',
]);

/** ccTLD second-level registries (example.co.uk → three labels). */
const SECOND_LEVEL_LABELS = new Set([
  'co',
  'com',
  'net',
  'org',
  'ac',
  'gov',
  'edu',
]);

/**
 * Registrable-domain heuristic: the last two hostname labels, or three when
 * the TLD is a two-letter country code behind a common second-level registry
 * (`co.uk`, `com.au`). Deliberately simple — it only decides whether a link
 * is "the same site" as the listing page.
 */
function registrableDomain(hostname: string): string {
  const labels = hostname.toLowerCase().split('.').filter(Boolean);
  if (labels.length <= 2) return labels.join('.');
  const tld = labels[labels.length - 1] ?? '';
  const second = labels[labels.length - 2] ?? '';
  if (tld.length === 2 && SECOND_LEVEL_LABELS.has(second)) {
    return labels.slice(-3).join('.');
  }
  return labels.slice(-2).join('.');
}

/** Same host + path (trailing slashes ignored) — a filtered/paginated view
 *  of the very page we are on, never an individual job. */
function samePathAsBase(url: URL, base: URL): boolean {
  return (
    url.hostname.toLowerCase() === base.hostname.toLowerCase() &&
    url.pathname.replace(/\/+$/, '') === base.pathname.replace(/\/+$/, '')
  );
}

/** Path segments that mark a careers AREA of the site (any position). */
const CAREERS_SEGMENTS = new Set([
  'career',
  'careers',
  'jobs',
  'positions',
  'openings',
]);

/**
 * A final path segment shaped like an ATS-minted job id: a slug ENDING in a
 * long (6+ digit) numeric id (`phd-genai-research-scientist-intern-7011263002`
 * — the databricks shape) or the bare id itself (`7011263002`). Six digits
 * keeps marketing suffixes out: `/careers/team-5` and year-stamped slugs
 * never qualify.
 */
const NUMERIC_ID_FINAL_SEGMENT_RE = /(?:^|-)\d{6,}$/;

/**
 * Job-DETAIL path patterns on the company's own domain: `/job/<x>`,
 * `/jobs/<id-or-slug>`, `/position/<x>`, `/careers/…/details/<x>` (details
 * anywhere below careers, with a segment after it), a careers-ish path
 * (`career(s)/jobs/positions/openings` segment) whose FINAL segment ends in
 * a long numeric ATS id, or a `?gh_jid=` param. The segment after
 * job/jobs/position must not itself be listing chrome (`/jobs/search`).
 */
function looksLikeJobDetailUrl(url: URL): boolean {
  if (url.searchParams.get('gh_jid')) return true;
  const segments = url.pathname
    .toLowerCase()
    .split('/')
    .filter((segment) => segment.length > 0);
  const detailIdx = segments.findIndex(
    (segment) =>
      segment === 'job' || segment === 'jobs' || segment === 'position',
  );
  if (detailIdx !== -1) {
    const follower = segments[detailIdx + 1];
    if (follower !== undefined && !NON_DETAIL_FOLLOWERS.has(follower)) {
      return true;
    }
  }
  const finalSegment = segments[segments.length - 1];
  if (
    finalSegment !== undefined &&
    NUMERIC_ID_FINAL_SEGMENT_RE.test(finalSegment) &&
    segments.some((segment) => CAREERS_SEGMENTS.has(segment))
  ) {
    return true;
  }
  const careersIdx = segments.indexOf('careers');
  const detailsIdx = segments.indexOf('details');
  return (
    careersIdx !== -1 &&
    detailsIdx > careersIdx &&
    detailsIdx < segments.length - 1
  );
}

/**
 * Filter collected anchors down to candidate individual-job links: supported
 * ATS hosts (detectPlatform) always qualify; same-registrable-domain links
 * qualify when their path reads as a job DETAIL page and is not the listing
 * page itself. Pagination-text anchors and duplicates (canonical-URL keyed,
 * so tracking-param variants collapse) are dropped; output order is document
 * order, capped at MAX_LISTING_LINKS. The ≥LISTING_LINKS_MIN threshold is
 * the CALLER's call (discover-form) — this returns every qualifying link.
 */
export function extractListingLinks(
  anchors: AnchorCandidate[],
  baseUrl: string,
): string[] {
  let base: URL | null = null;
  try {
    base = new URL(baseUrl);
  } catch {
    base = null;
  }
  const baseDomain = base ? registrableDomain(base.hostname) : null;
  const baseKey = base ? canonicalizeUrl(base.toString()) : null;

  const out: string[] = [];
  const seen = new Set<string>();
  for (const anchor of anchors) {
    if (out.length >= MAX_LISTING_LINKS) break;
    let url: URL;
    try {
      url = new URL(anchor.href);
    } catch {
      continue;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
    if (PAGINATION_TEXT_RE.test(anchor.text.trim())) continue;

    const supported =
      detectPlatform(canonicalizeUrl(anchor.href)).platform !== 'unknown';
    const sameSiteDetail =
      !supported &&
      base !== null &&
      baseDomain !== null &&
      registrableDomain(url.hostname) === baseDomain &&
      !samePathAsBase(url, base) &&
      looksLikeJobDetailUrl(url);
    if (!supported && !sameSiteDetail) continue;

    url.hash = '';
    const cleaned = url.toString();
    const key = canonicalizeUrl(cleaned);
    if (key === baseKey || seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned);
  }
  return out;
}
