import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertSafeFetchTarget,
  extractAnchorHrefs,
  extractUrlsFromText,
  fetchJobLinks,
  fetchPageHtml,
  isIngestableJobUrl,
  sniffGreenhouseJob,
  unwrapRedirectShim,
} from './link-extract.js';

describe('extractUrlsFromText', () => {
  it('pulls distinct http(s) urls, unwrapping angle brackets + markdown', () => {
    const text = [
      'check https://boards.greenhouse.io/acme/jobs/1',
      'and <https://jobs.lever.co/acme/2>',
      'plus [this](https://jobs.ashbyhq.com/acme/3).',
      'dupe: https://boards.greenhouse.io/acme/jobs/1',
    ].join('\n');
    expect(extractUrlsFromText(text)).toEqual([
      'https://boards.greenhouse.io/acme/jobs/1',
      'https://jobs.lever.co/acme/2',
      'https://jobs.ashbyhq.com/acme/3',
    ]);
  });

  it('trims trailing punctuation and returns [] for no urls', () => {
    expect(extractUrlsFromText('go to https://x.example/job, now!')).toEqual([
      'https://x.example/job',
    ]);
    expect(extractUrlsFromText('no links here')).toEqual([]);
  });
});

describe('unwrapRedirectShim', () => {
  it('decodes the target from an instagram shim link', () => {
    const target = 'https://careers.twosigma.com/careers/JobDetail/12345';
    const shim = `https://l.instagram.com/?u=${encodeURIComponent(target)}&e=xyz`;
    expect(unwrapRedirectShim(shim)).toBe(target);
  });

  it('decodes the target from a google /url?q= shim link', () => {
    const target = 'https://boards.greenhouse.io/acme/jobs/1';
    const shim = `https://www.google.com/url?q=${encodeURIComponent(target)}`;
    expect(unwrapRedirectShim(shim)).toBe(target);
  });

  it('leaves a google careers url with a non-URL ?q= unchanged', () => {
    const url =
      'https://www.google.com/about/careers/applications/jobs/results/?q=ai+catalyst';
    expect(unwrapRedirectShim(url)).toBe(url);
  });

  it('leaves a non-shim url unchanged', () => {
    const url = 'https://boards.greenhouse.io/acme/jobs/1?u=ignored';
    expect(unwrapRedirectShim(url)).toBe(url);
  });

  it('fully unwraps a shim that wraps another shim', () => {
    const target = 'https://jobs.lever.co/acme/2';
    const inner = `https://l.facebook.com/l.php?u=${encodeURIComponent(target)}`;
    const outer = `https://l.instagram.com/?u=${encodeURIComponent(inner)}`;
    expect(unwrapRedirectShim(outer)).toBe(target);
  });
});

describe('extractAnchorHrefs', () => {
  it('resolves relative hrefs against the base and drops non-http', () => {
    const html = `
      <a href="/jobs/1">one</a>
      <a href='https://boards.greenhouse.io/acme/jobs/2'>two</a>
      <a href="mailto:x@y.com">mail</a>
      <a href="#frag">frag</a>`;
    expect(extractAnchorHrefs(html, 'https://dir.example/list')).toEqual([
      'https://dir.example/jobs/1',
      'https://boards.greenhouse.io/acme/jobs/2',
      'https://dir.example/list#frag',
    ]);
  });
});

describe('assertSafeFetchTarget (SSRF guard)', () => {
  it('rejects non-http(s), localhost, internal, and private/metadata IPs', () => {
    for (const bad of [
      'ftp://example.com',
      'file:///etc/passwd',
      'http://localhost/x',
      'http://foo.internal/x',
      'http://service.local/x',
      'http://127.0.0.1/x',
      'http://10.0.0.5/x',
      'http://192.168.1.1/x',
      'http://172.16.0.1/x',
      'http://169.254.169.254/latest/meta-data', // cloud metadata
      'http://[::1]/x',
    ]) {
      expect(() => assertSafeFetchTarget(bad), bad).toThrow();
    }
  });

  it('allows public http(s) urls', () => {
    expect(() =>
      assertSafeFetchTarget('https://boards.greenhouse.io/acme/jobs/1'),
    ).not.toThrow();
    expect(() => assertSafeFetchTarget('http://8.8.8.8/x')).not.toThrow();
  });
});

describe('fetchJobLinks', () => {
  afterEach(() => vi.restoreAllMocks());

  it('returns only anchors on supported job platforms', async () => {
    const html = `
      <a href="https://boards.greenhouse.io/acme/jobs/1">gh</a>
      <a href="https://jobs.lever.co/acme/2">lever</a>
      <a href="https://twitter.com/acme">social</a>
      <a href="/about">about</a>`;
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(html, {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
    );
    const links = await fetchJobLinks('https://dir.example/board');
    expect(links).toEqual([
      'https://boards.greenhouse.io/acme/jobs/1',
      'https://jobs.lever.co/acme/2',
    ]);
  });

  it('returns [] for non-HTML or failed responses', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    expect(await fetchJobLinks('https://dir.example/api')).toEqual([]);
  });

  it('refuses to fetch a private-IP url (SSRF guard)', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    expect(await fetchJobLinks('http://169.254.169.254/')).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('fetchPageHtml', () => {
  afterEach(() => vi.restoreAllMocks());

  it('returns the HTML with the final URL, and null for non-HTML/private targets', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('<p>hi</p>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }),
    );
    expect(await fetchPageHtml('https://dir.example/board')).toEqual({
      html: '<p>hi</p>',
      url: 'https://dir.example/board',
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    expect(await fetchPageHtml('https://dir.example/api')).toBeNull();
    expect(await fetchPageHtml('http://169.254.169.254/')).toBeNull();
  });
});

describe('isIngestableJobUrl', () => {
  it('is true for non-workday platforms unconditionally', () => {
    expect(
      isIngestableJobUrl('greenhouse', 'https://boards.greenhouse.io/a/jobs/1'),
    ).toBe(true);
    expect(isIngestableJobUrl('lever', 'not a url')).toBe(true);
  });

  it('requires a /job/ or /details/ path for workday', () => {
    expect(
      isIngestableJobUrl(
        'workday',
        'https://caci.wd1.myworkdayjobs.com/External/job/Jessup/SWE_1',
      ),
    ).toBe(true);
    expect(
      isIngestableJobUrl(
        'workday',
        'https://caci.wd1.myworkdayjobs.com/External/login',
      ),
    ).toBe(false);
    expect(isIngestableJobUrl('workday', 'not a url')).toBe(false);
  });
});

describe('sniffGreenhouseJob', () => {
  const PAGE = 'https://stripe.com/jobs/listing/backend-engineer/7031337';

  it('finds tenant + job id in a classic job_app embed (entity-escaped &amp;)', () => {
    const html =
      '<div id="grnhse_app"></div>' +
      '<script src="https://boards.greenhouse.io/embed/job_app?for=stripe&amp;token=7031337&amp;b=https%3A%2F%2Fstripe.com"></script>';
    expect(sniffGreenhouseJob(html, PAGE)).toEqual({
      tenant: 'stripe',
      jobId: '7031337',
    });
  });

  it('finds a JSON-escaped (\\u0026) embed inside an inline script', () => {
    const html =
      '{"embed":"https://boards.greenhouse.io/embed/job_app?for=databricks\\u0026token=999"}';
    expect(sniffGreenhouseJob(html, PAGE)).toEqual({
      tenant: 'databricks',
      jobId: '999',
    });
  });

  it('finds a single job-boards.greenhouse.io/<tenant>/jobs/<id> link', () => {
    const html =
      '<a href="https://job-boards.greenhouse.io/stripe/jobs/7031337">Apply</a>';
    expect(sniffGreenhouseJob(html, 'https://stripe.com/jobs/x')).toEqual({
      tenant: 'stripe',
      jobId: '7031337',
    });
  });

  it('finds a boards.eu.greenhouse.io board link too', () => {
    const html =
      '<a href="https://boards.eu.greenhouse.io/acme/jobs/123">Apply</a>';
    expect(sniffGreenhouseJob(html, 'https://acme.eu/careers/x')).toEqual({
      tenant: 'acme',
      jobId: '123',
    });
  });

  it('combines a gh_jid page param with a board link naming the tenant', () => {
    const html =
      '<a href="https://boards.greenhouse.io/acme/jobs/999">other role</a>';
    expect(
      sniffGreenhouseJob(html, 'https://acme.com/jobs/search?gh_jid=42'),
    ).toEqual({ tenant: 'acme', jobId: '42' });
  });

  it('combines a gh_jid page param with a token-less job_app embed', () => {
    const html =
      '<iframe src="https://boards.greenhouse.io/embed/job_app?for=acme"></iframe>';
    expect(
      sniffGreenhouseJob(html, 'https://acme.com/careers?gh_jid=456'),
    ).toEqual({ tenant: 'acme', jobId: '456' });
  });

  it('prefers the page gh_jid over an embed token (the page pins the job)', () => {
    const html =
      '<script src="https://boards.greenhouse.io/embed/job_app?for=acme&amp;token=111"></script>';
    expect(
      sniffGreenhouseJob(html, 'https://acme.com/careers?gh_jid=222'),
    ).toEqual({ tenant: 'acme', jobId: '222' });
  });

  it('returns null for a directory page with SEVERAL distinct board links', () => {
    const html = [
      '<a href="https://boards.greenhouse.io/acme/jobs/1">a</a>',
      '<a href="https://boards.greenhouse.io/acme/jobs/2">b</a>',
    ].join('');
    expect(sniffGreenhouseJob(html, 'https://acme.com/careers')).toBeNull();
  });

  it('treats repeated links to the SAME job as one job, not a directory', () => {
    const html = [
      '<a href="https://boards.greenhouse.io/acme/jobs/1">apply</a>',
      '<a href="https://job-boards.greenhouse.io/acme/jobs/1">apply again</a>',
    ].join('');
    expect(sniffGreenhouseJob(html, 'https://acme.com/careers')).toEqual({
      tenant: 'acme',
      jobId: '1',
    });
  });

  it('returns null when the page has no greenhouse marker', () => {
    const html = '<html><body><a href="/apply">Apply here</a></body></html>';
    expect(sniffGreenhouseJob(html, 'https://acme.com/careers/x')).toBeNull();
    // gh_jid alone (no marker naming the tenant) cannot build a board URL.
    expect(
      sniffGreenhouseJob(html, 'https://acme.com/careers?gh_jid=7'),
    ).toBeNull();
  });
});
