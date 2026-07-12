import { describe, expect, it } from 'vitest';
import { canonicalizeUrl } from './canonical-url.js';

describe('canonicalizeUrl', () => {
  it('lowercases the host', () => {
    expect(canonicalizeUrl('https://Boards.Greenhouse.IO/acme/jobs/123')).toBe(
      'https://boards.greenhouse.io/acme/jobs/123',
    );
  });

  it('preserves path case (only the host is lowercased)', () => {
    expect(canonicalizeUrl('https://EXAMPLE.com/Jobs/Acme')).toBe(
      'https://example.com/Jobs/Acme',
    );
  });

  it('strips the hash fragment', () => {
    expect(canonicalizeUrl('https://example.com/jobs/1#apply-now')).toBe(
      'https://example.com/jobs/1',
    );
  });

  it('strips a trailing slash from the path', () => {
    expect(canonicalizeUrl('https://example.com/jobs/1/')).toBe(
      'https://example.com/jobs/1',
    );
  });

  it('strips repeated trailing slashes', () => {
    expect(canonicalizeUrl('https://example.com/jobs/1///')).toBe(
      'https://example.com/jobs/1',
    );
  });

  it('strips the trailing slash on a bare-root URL', () => {
    expect(canonicalizeUrl('https://Example.com/')).toBe('https://example.com');
    expect(canonicalizeUrl('https://example.com')).toBe('https://example.com');
  });

  it('keeps gh_jid and only gh_jid', () => {
    expect(
      canonicalizeUrl(
        'https://boards.greenhouse.io/acme?gh_jid=4021&foo=bar&page=2',
      ),
    ).toBe('https://boards.greenhouse.io/acme?gh_jid=4021');
  });

  it('drops utm_* params explicitly', () => {
    expect(
      canonicalizeUrl(
        'https://example.com/jobs/1?utm_source=simplify&utm_medium=email&utm_campaign=x',
      ),
    ).toBe('https://example.com/jobs/1');
  });

  it('drops ref and src params explicitly', () => {
    expect(
      canonicalizeUrl('https://example.com/jobs/1?ref=Simplify&src=newsletter'),
    ).toBe('https://example.com/jobs/1');
  });

  it('drops all other query params', () => {
    expect(
      canonicalizeUrl('https://example.com/jobs/1?session=abc&lang=en&t=99'),
    ).toBe('https://example.com/jobs/1');
  });

  it('drops the ? entirely when no params survive', () => {
    expect(canonicalizeUrl('https://example.com/jobs/1?utm_source=x')).toBe(
      'https://example.com/jobs/1',
    );
    expect(canonicalizeUrl('https://example.com/jobs/1?')).toBe(
      'https://example.com/jobs/1',
    );
  });

  it('handles hash, trailing slash, tracking and gh_jid together', () => {
    expect(
      canonicalizeUrl(
        'https://Boards.Greenhouse.io/acme/jobs/123/?gh_jid=123&utm_source=x&ref=y&src=z&other=1#app',
      ),
    ).toBe('https://boards.greenhouse.io/acme/jobs/123?gh_jid=123');
  });

  it('keeps only the first gh_jid when it is repeated', () => {
    expect(canonicalizeUrl('https://example.com/j?gh_jid=1&gh_jid=2')).toBe(
      'https://example.com/j?gh_jid=1',
    );
  });

  it('preserves an explicit port on the host', () => {
    expect(canonicalizeUrl('http://LocalHost:8080/jobs/1/')).toBe(
      'http://localhost:8080/jobs/1',
    );
  });

  it('is idempotent', () => {
    const once = canonicalizeUrl(
      'https://EXAMPLE.com/jobs/1/?gh_jid=9&utm_source=x#frag',
    );
    expect(canonicalizeUrl(once)).toBe(once);
  });

  it('throws on invalid URLs', () => {
    expect(() => canonicalizeUrl('not a url')).toThrow(TypeError);
    expect(() => canonicalizeUrl('')).toThrow(TypeError);
  });
});
