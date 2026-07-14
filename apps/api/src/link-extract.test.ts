import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertSafeFetchTarget,
  extractAnchorHrefs,
  extractUrlsFromText,
  fetchJobLinks,
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
