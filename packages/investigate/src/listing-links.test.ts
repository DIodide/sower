import { describe, expect, it } from 'vitest';
import {
  extractListingLinks,
  LISTING_LINKS_MIN,
  MAX_LISTING_LINKS,
} from './listing-links.js';
import type { AnchorCandidate } from './page-functions.js';

const BASE =
  'https://www.databricks.com/company/careers/open-positions?department=eng';

function a(href: string, text = 'Software Engineer Intern'): AnchorCandidate {
  return { href, text };
}

describe('extractListingLinks', () => {
  it('keeps anchors on supported ATS hosts (detectPlatform-recognized)', () => {
    const links = extractListingLinks(
      [
        a('https://boards.greenhouse.io/acme/jobs/123'),
        a('https://jobs.lever.co/acme/uuid-1'),
        a('https://jobs.ashbyhq.com/acme/uuid-2'),
        a('https://acme.wd5.myworkdayjobs.com/External/job/NYC/SWE_JR1'),
      ],
      BASE,
    );
    expect(links).toEqual([
      'https://boards.greenhouse.io/acme/jobs/123',
      'https://jobs.lever.co/acme/uuid-1',
      'https://jobs.ashbyhq.com/acme/uuid-2',
      'https://acme.wd5.myworkdayjobs.com/External/job/NYC/SWE_JR1',
    ]);
  });

  it('keeps custom-domain greenhouse links (?gh_jid=) — the databricks case — even on the listing path itself', () => {
    // Real shape: the SPA opens each job as ?gh_jid=<id> on the same path.
    const links = extractListingLinks(
      [
        a(`${BASE.split('?')[0]}?gh_jid=6866484002`),
        a(
          'https://www.databricks.com/company/careers/university-recruiting/software-engineering-intern-6866484002?gh_jid=6866484002',
        ),
      ],
      BASE,
    );
    expect(links).toHaveLength(2);
    expect(links[0]).toContain('gh_jid=6866484002');
  });

  it('keeps same-registrable-domain job-DETAIL paths and drops other same-site links', () => {
    const base = 'https://example.com/careers';
    const links = extractListingLinks(
      [
        a('https://example.com/careers/jobs/swe-intern-1234'),
        a('https://careers.example.com/job/1234'), // subdomain, same domain
        a('https://example.com/position/swe-intern'),
        a('https://example.com/careers/university/details/swe-intern'),
        a('https://example.com/about'), // not a job path
        a('https://example.com/careers/jobs/search?q=intern'), // listing chrome
        a('https://example.com/blog/how-we-hire'), // not a job path
      ],
      base,
    );
    expect(links).toEqual([
      'https://example.com/careers/jobs/swe-intern-1234',
      'https://careers.example.com/job/1234',
      'https://example.com/position/swe-intern',
      'https://example.com/careers/university/details/swe-intern',
    ]);
  });

  it('keeps careers-path slugs ending in a long numeric ATS id (the databricks live shape), dropping nav noise', () => {
    // Live finding: databricks renders its university-recruiting jobs as
    // same-domain slugs suffixed with the greenhouse id — no /job/ segment,
    // no gh_jid param. Exactly three such anchors rendered; all must be kept.
    const base =
      'https://www.databricks.com/company/careers/university-recruiting';
    const links = extractListingLinks(
      [
        a(
          `${base}/phd-genai-research-scientist-intern-7011263002`,
          'PhD GenAI Research Scientist Intern',
        ),
        a(
          `${base}/software-engineering-intern-6866484002`,
          'Software Engineering Intern',
        ),
        a(`${base}/data-science-intern-6866484003`, 'Data Science Intern'),
        a(`${base}?dept=eng`, 'Filters'), // filter chrome by text
        a(base, 'University Recruiting'), // self-link
        a('https://www.databricks.com/company/contact', 'Contact'),
        a('https://twitter.com/databricks', 'Twitter'),
      ],
      base,
    );
    expect(links).toEqual([
      `${base}/phd-genai-research-scientist-intern-7011263002`,
      `${base}/software-engineering-intern-6866484002`,
      `${base}/data-science-intern-6866484003`,
    ]);
    expect(links.length).toBeGreaterThanOrEqual(LISTING_LINKS_MIN);
  });

  it('keeps a purely numeric final segment under a careers-ish path', () => {
    const links = extractListingLinks(
      [a('https://example.com/careers/7011263002')],
      'https://example.com/careers',
    );
    expect(links).toEqual(['https://example.com/careers/7011263002']);
  });

  it('rejects short numeric suffixes (marketing pages) and numeric ids outside a careers path', () => {
    const links = extractListingLinks(
      [
        a('https://example.com/careers/team-5'), // short suffix — not an ATS id
        a('https://example.com/careers/our-team-2024'), // year-stamped slug
        a('https://example.com/blog/post-7011263002'), // long id, but no careers-ish segment
        a('https://example.com/careers/swe-x7011263002'), // digits not dash-separated
      ],
      'https://example.com/about',
    );
    expect(links).toEqual([]);
  });

  it('drops cross-domain non-ATS links (aggregators, socials)', () => {
    const links = extractListingLinks(
      [
        a('https://twitter.com/databricks'),
        a('https://www.linkedin.com/company/databricks/jobs/123'),
        a('https://otherco.example/jobs/456'),
      ],
      BASE,
    );
    expect(links).toEqual([]);
  });

  it('drops pagination/filter anchors by their link text', () => {
    const detail = 'https://www.databricks.com/company/careers/job/1234';
    const links = extractListingLinks(
      [
        a(detail, 'Next'),
        a(detail, 'Previous'),
        a(detail, '2'),
        a(detail, 'Load more'),
        a(detail, 'Filters'),
        a(detail, 'Clear all'),
        a(detail, '»'),
      ],
      BASE,
    );
    expect(links).toEqual([]);
  });

  it('drops links back to the listing page itself (filter/pagination views)', () => {
    const path = BASE.split('?')[0] ?? '';
    const links = extractListingLinks(
      [a(`${path}?page=2`), a(`${path}/`), a(`${path}#openings`)],
      BASE,
    );
    expect(links).toEqual([]);
  });

  it('dedupes canonically (tracking params, hashes, and repeats collapse)', () => {
    const detail = 'https://www.databricks.com/company/careers/job/1234';
    const links = extractListingLinks(
      [a(detail), a(`${detail}?utm_source=x`), a(`${detail}#apply`), a(detail)],
      BASE,
    );
    expect(links).toEqual([detail]);
  });

  it('caps the output at 50 links, preserving document order', () => {
    const anchors = Array.from({ length: 60 }, (_, i) =>
      a(`https://www.databricks.com/company/careers/job/${i}`),
    );
    const links = extractListingLinks(anchors, BASE);
    expect(links).toHaveLength(MAX_LISTING_LINKS);
    expect(links[0]).toBe('https://www.databricks.com/company/careers/job/0');
    expect(links[49]).toBe('https://www.databricks.com/company/careers/job/49');
  });

  it('applies NO minimum here — the ≥LISTING_LINKS_MIN threshold is the caller’s call', () => {
    const links = extractListingLinks(
      [a('https://boards.greenhouse.io/acme/jobs/1')],
      BASE,
    );
    expect(links).toHaveLength(1);
    expect(links.length).toBeLessThan(LISTING_LINKS_MIN);
  });

  it('sets the listing threshold at 2 — a 2-job team page expands, a single link does not', () => {
    expect(LISTING_LINKS_MIN).toBe(2);
  });

  it('tolerates malformed hrefs and an unparseable base', () => {
    expect(
      extractListingLinks(
        [a('not a url'), a('https://boards.greenhouse.io/acme/jobs/1')],
        'about:blank',
      ),
    ).toEqual(['https://boards.greenhouse.io/acme/jobs/1']);
  });
});
