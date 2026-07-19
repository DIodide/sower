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

  it('applies NO minimum here — the ≥3 listing threshold is the caller’s call', () => {
    const links = extractListingLinks(
      [
        a('https://boards.greenhouse.io/acme/jobs/1'),
        a('https://boards.greenhouse.io/acme/jobs/2'),
      ],
      BASE,
    );
    expect(links).toHaveLength(2);
    expect(links.length).toBeLessThan(LISTING_LINKS_MIN);
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
