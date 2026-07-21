import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchIdToken, resetIdTokenCache } from './oidc.js';

const AUDIENCE = 'https://sower-compile-abc.a.run.app';

beforeEach(() => {
  resetIdTokenCache();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('fetchIdToken', () => {
  it('mints a token from the metadata server with the encoded audience', async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => new Response('id-token\n'));
    const token = await fetchIdToken(AUDIENCE, fetchFn);
    expect(token).toBe('id-token');
    const [url, init] = fetchFn.mock.calls[0] ?? [];
    expect(String(url)).toBe(
      `http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience=${encodeURIComponent(AUDIENCE)}`,
    );
    expect(init?.headers).toEqual({ 'Metadata-Flavor': 'Google' });
  });

  it('caches per audience', async () => {
    const fetchFn = vi.fn<typeof fetch>(
      async (input) =>
        new Response(String(input).includes('aud-a') ? 'token-a' : 'token-b'),
    );
    expect(await fetchIdToken('https://aud-a.run.app', fetchFn)).toBe(
      'token-a',
    );
    expect(await fetchIdToken('https://aud-a.run.app', fetchFn)).toBe(
      'token-a',
    );
    expect(fetchFn).toHaveBeenCalledTimes(1);
    // A different audience is a different token — never the cached one.
    expect(await fetchIdToken('https://aud-b.run.app', fetchFn)).toBe(
      'token-b',
    );
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('refreshes a cached token after 50 minutes', async () => {
    vi.useFakeTimers();
    const fetchFn = vi.fn<typeof fetch>(async () => new Response('tok'));
    await fetchIdToken(AUDIENCE, fetchFn);
    vi.advanceTimersByTime(49 * 60 * 1000);
    await fetchIdToken(AUDIENCE, fetchFn);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2 * 60 * 1000);
    await fetchIdToken(AUDIENCE, fetchFn);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('throws on a non-200 and does not cache the failure', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('denied', { status: 403 }))
      .mockResolvedValueOnce(new Response('tok'));
    await expect(fetchIdToken(AUDIENCE, fetchFn)).rejects.toThrow(
      'metadata identity request failed: HTTP 403',
    );
    await expect(fetchIdToken(AUDIENCE, fetchFn)).resolves.toBe('tok');
  });

  it('propagates the fetch failure off-GCP (no metadata server)', async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => {
      throw new TypeError('ENOTFOUND metadata.google.internal');
    });
    await expect(fetchIdToken(AUDIENCE, fetchFn)).rejects.toThrow('ENOTFOUND');
  });

  it('resetIdTokenCache forces a refetch', async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => new Response('tok'));
    await fetchIdToken(AUDIENCE, fetchFn);
    resetIdTokenCache();
    await fetchIdToken(AUDIENCE, fetchFn);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});
