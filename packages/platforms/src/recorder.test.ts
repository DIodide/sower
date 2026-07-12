import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type ApiCallRecord,
  MAX_RECORDED_BODY_CHARS,
  recordedFetch,
  safeRecord,
} from './recorder.js';

const url = 'https://boards-api.example.com/v1/things';

function lastCall(recorder: ReturnType<typeof vi.fn>): ApiCallRecord {
  const call = recorder.mock.calls.at(-1)?.[0] as ApiCallRecord | undefined;
  if (!call) {
    throw new Error('recorder was never invoked');
  }
  return call;
}

describe('recordedFetch', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('passes straight through to fetch when no recorder is given', async () => {
    const fakeResponse = { clone: vi.fn() } as unknown as Response;
    const fetchMock = vi.fn().mockResolvedValue(fakeResponse);
    vi.stubGlobal('fetch', fetchMock);

    const init: RequestInit = { method: 'GET' };
    const response = await recordedFetch(undefined, 'discover', url, init);

    expect(response).toBe(fakeResponse);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(url, init);
    // No capture happens without a recorder — the response is untouched.
    expect(
      (fakeResponse as unknown as { clone: unknown }).clone,
    ).not.toHaveBeenCalled();
  });

  it('records phase, method, url, status, duration and parses a JSON body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: 1 }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const recorder = vi.fn();

    const response = await recordedFetch(recorder, 'discover', url, {
      method: 'post',
    });

    // The original response is returned with its body still readable.
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({ ok: 1 });

    expect(recorder).toHaveBeenCalledTimes(1);
    const call = lastCall(recorder);
    expect(call.phase).toBe('discover');
    expect(call.method).toBe('POST');
    expect(call.url).toBe(url);
    expect(call.responseStatus).toBe(201);
    expect(call.responseBody).toEqual({ ok: 1 });
    expect(call.responseHeaders?.['content-type']).toBe('application/json');
    expect(call.durationMs).toBeGreaterThanOrEqual(0);
    expect(call.dryRun).toBeUndefined();
  });

  it('redacts authorization/cookie/x-api-key request headers case-insensitively', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('')));
    const recorder = vi.fn();

    await recordedFetch(recorder, 'discover', url, {
      headers: {
        Authorization: 'Bearer topsecret',
        Cookie: 'session=abc123',
        'X-Api-Key': 'sower-key',
        Accept: 'application/json',
      },
    });

    expect(lastCall(recorder).requestHeaders).toEqual({
      Authorization: '[REDACTED]',
      Cookie: '[REDACTED]',
      'X-Api-Key': '[REDACTED]',
      Accept: 'application/json',
    });
  });

  it('redacts headers passed as a Headers instance', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('')));
    const recorder = vi.fn();

    await recordedFetch(recorder, 'discover', url, {
      headers: new Headers({
        authorization: 'Bearer topsecret',
        accept: 'text/html',
      }),
    });

    expect(lastCall(recorder).requestHeaders).toEqual({
      authorization: '[REDACTED]',
      accept: 'text/html',
    });
  });

  it('redacts set-cookie in response headers', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response('hello', {
          status: 200,
          headers: {
            'set-cookie': 'sid=secret; HttpOnly',
            'content-type': 'text/plain',
          },
        }),
      ),
    );
    const recorder = vi.fn();

    await recordedFetch(recorder, 'discover', url);

    const call = lastCall(recorder);
    expect(call.responseHeaders?.['set-cookie']).toBe('[REDACTED]');
    expect(call.responseHeaders?.['content-type']).toContain('text/plain');
    expect(JSON.stringify(call)).not.toContain('sid=secret');
  });

  it('caps big response bodies at 64KB with a truncated marker', async () => {
    const big = 'x'.repeat(MAX_RECORDED_BODY_CHARS + 1_000);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(big, { status: 200 })),
    );
    const recorder = vi.fn();

    const response = await recordedFetch(recorder, 'discover', url);

    const body = lastCall(recorder).responseBody as {
      truncated: boolean;
      totalChars: number;
      preview: string;
    };
    expect(body.truncated).toBe(true);
    expect(body.totalChars).toBe(big.length);
    expect(body.preview).toHaveLength(MAX_RECORDED_BODY_CHARS);
    // The caller still gets the full, untruncated body.
    await expect(response.text()).resolves.toHaveLength(big.length);
  });

  it('caps big request bodies and parses JSON request bodies', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('')));
    const recorder = vi.fn();

    await recordedFetch(recorder, 'discover', url, {
      method: 'POST',
      body: JSON.stringify({ first_name: 'Jane' }),
    });
    expect(lastCall(recorder).requestBody).toEqual({ first_name: 'Jane' });

    const big = 'y'.repeat(MAX_RECORDED_BODY_CHARS + 5);
    await recordedFetch(recorder, 'discover', url, {
      method: 'POST',
      body: big,
    });
    expect(lastCall(recorder).requestBody).toMatchObject({
      truncated: true,
      totalChars: big.length,
    });
  });

  it('falls back to raw text for non-JSON bodies', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('<html>nope</html>')),
    );
    const recorder = vi.fn();

    await recordedFetch(recorder, 'discover', url, {
      method: 'POST',
      body: 'plain text',
    });

    const call = lastCall(recorder);
    expect(call.requestBody).toBe('plain text');
    expect(call.responseBody).toBe('<html>nope</html>');
  });

  it('never throws when the recorder itself fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('ok', { status: 200 })),
    );
    const recorder = vi.fn().mockRejectedValue(new Error('db down'));

    const response = await recordedFetch(recorder, 'discover', url);

    expect(response.status).toBe(200);
    expect(recorder).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('recorder failed'),
      expect.any(Error),
    );
  });

  it('never throws when the response cannot be captured (no clone)', async () => {
    const unclonable = {
      ok: true,
      status: 200,
      json: async () => ({}),
    } as unknown as Response;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(unclonable));
    const recorder = vi.fn();

    const response = await recordedFetch(recorder, 'discover', url);

    expect(response).toBe(unclonable);
    expect(recorder).toHaveBeenCalledTimes(1);
    expect(lastCall(recorder).responseStatus).toBe(200);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('records the attempt and rethrows untouched when fetch rejects', async () => {
    const failure = new Error('network unreachable');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(failure));
    const recorder = vi.fn();

    await expect(recordedFetch(recorder, 'discover', url)).rejects.toBe(
      failure,
    );

    expect(recorder).toHaveBeenCalledTimes(1);
    const call = lastCall(recorder);
    expect(call.phase).toBe('discover');
    expect(call.responseStatus).toBeUndefined();
    expect(call.responseBody).toBeUndefined();
  });
});

describe('safeRecord', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is a no-op without a recorder and swallows recorder errors', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const record: ApiCallRecord = {
      phase: 'submit_dryrun',
      method: 'POST',
      url,
      durationMs: 0,
      dryRun: true,
    };

    await expect(safeRecord(undefined, record)).resolves.toBeUndefined();

    const throwing = vi.fn(() => {
      throw new Error('sync boom');
    });
    await expect(safeRecord(throwing, record)).resolves.toBeUndefined();
    expect(throwing).toHaveBeenCalledWith(record);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});
