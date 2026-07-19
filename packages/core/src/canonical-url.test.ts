import { describe, expect, it } from 'vitest';
import { canonicalizeUrl, stripTrackingParams } from './canonical-url.js';

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

  it('accepts non-http schemes (manual:// placeholder URLs round-trip)', () => {
    // POST /ingest/manual records URL-less jobs under manual://<uuid>; the
    // uuid parses as the host, so it survives canonicalization (lowercased).
    expect(
      canonicalizeUrl('manual://3f2b8c9e-1a2b-4c3d-8e9f-0a1b2c3d4e5f'),
    ).toBe('manual://3f2b8c9e-1a2b-4c3d-8e9f-0a1b2c3d4e5f');
    expect(canonicalizeUrl('manual://ABC-DEF')).toBe('manual://abc-def');
  });

  it('throws on invalid URLs', () => {
    expect(() => canonicalizeUrl('not a url')).toThrow(TypeError);
    expect(() => canonicalizeUrl('')).toThrow(TypeError);
  });
});

describe('stripTrackingParams', () => {
  it('strips gh_src (the zero2sudo referral case) but keeps functional params', () => {
    expect(
      stripTrackingParams(
        'https://job-boards.greenhouse.io/thetradedesk/jobs/5033765007?gh_src=zero2sudo',
      ),
    ).toBe('https://job-boards.greenhouse.io/thetradedesk/jobs/5033765007');
    expect(
      stripTrackingParams(
        'https://stripe.com/jobs/search?gh_jid=123&gh_src=zero2sudo',
      ),
    ).toBe('https://stripe.com/jobs/search?gh_jid=123');
  });

  it('strips utm_*/ref/click ids, preserves path case + fragments, tolerates junk', () => {
    expect(
      stripTrackingParams(
        'https://X.example/Jobs/1?utm_source=a&ref=b&gclid=c&dept=Eng#apply',
      ),
    ).toBe('https://x.example/Jobs/1?dept=Eng#apply');
    expect(stripTrackingParams('not a url')).toBe('not a url');
  });
});
