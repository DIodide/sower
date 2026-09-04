import { describe, expect, it } from 'vitest';
import { resolveSowerConfig } from './config.js';
import { type FillPayload, makeSowerClient } from './sower-client.js';

/**
 * Route → request mapping with an injected fetch (no network): paths,
 * the x-api-key header sourced from env config, body shapes, and error
 * surfacing.
 */

const TOKEN = 'runner-token';
const BASE = 'https://api.example.test';

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function createClient(responses: { status?: number; body?: unknown }[] = []) {
  const requests: Recorded[] = [];
  const queue = [...responses];
  const fetchStub = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    requests.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers: { ...((init?.headers ?? {}) as Record<string, string>) },
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
    });
    const next = queue.shift() ?? { body: {} };
    return new Response(JSON.stringify(next.body ?? {}), {
      status: next.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  const config = resolveSowerConfig(
    { SOWER_API_KEY: TOKEN, SOWER_API_BASE: BASE },
    () => {
      throw new Error('ENOENT');
    },
  );
  if (config.token === null) {
    throw new Error('unreachable: env token is set');
  }
  const client = makeSowerClient({
    base: config.base,
    token: config.token,
    fetch: fetchStub,
  });
  return { client, requests };
}

const payload: FillPayload = {
  platform: 'greenhouse',
  applyUrl: 'https://job-boards.greenhouse.io/acme/jobs/123',
  company: 'Acme',
  title: 'Software Engineer',
  questions: [
    {
      id: 'q1',
      label: 'Full name*',
      type: 'text',
      required: true,
      options: [],
      values: ['Ada Lovelace'],
    },
  ],
};

describe('makeSowerClient', () => {
  it('claim: POST /fill-jobs/claim with the env token, mapped to job+payload', async () => {
    const { client, requests } = createClient([
      { body: { job: { id: 'j1', taskId: 't1' }, payload } },
    ]);
    const claimed = await client.claim();
    expect(claimed).toEqual({ job: { id: 'j1', taskId: 't1' }, payload });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(`${BASE}/fill-jobs/claim`);
    expect(requests[0]?.method).toBe('POST');
    expect(requests[0]?.headers['x-api-key']).toBe(TOKEN);
  });

  it('claim: {job: null} means an empty queue', async () => {
    const { client } = createClient([{ body: { job: null } }]);
    expect(await client.claim()).toBeNull();
  });

  it('report: posts status, live-view url and per-field outcomes', async () => {
    const { client, requests } = createClient([{ body: { job: {} } }]);
    await client.report('j1', {
      status: 'ready',
      report: [{ questionId: 'q1', label: 'Full name*', outcome: 'filled' }],
    });
    expect(requests[0]?.url).toBe(`${BASE}/fill-jobs/j1/report`);
    expect(requests[0]?.body).toEqual({
      status: 'ready',
      report: [{ questionId: 'q1', label: 'Full name*', outcome: 'filled' }],
    });
  });

  it('fail: posts the error, capped at 2000 chars', async () => {
    const { client, requests } = createClient([{ body: { job: {} } }]);
    await client.fail('j1', 'x'.repeat(3000));
    expect(requests[0]?.url).toBe(`${BASE}/fill-jobs/j1/fail`);
    expect(requests[0]?.body).toEqual({ error: 'x'.repeat(2000) });
  });

  it('heartbeat: POST /fill-jobs/:id/heartbeat', async () => {
    const { client, requests } = createClient([{ body: { ok: true } }]);
    await client.heartbeat('j1');
    expect(requests[0]?.url).toBe(`${BASE}/fill-jobs/j1/heartbeat`);
    expect(requests[0]?.method).toBe('POST');
  });

  it('surfaces the api error message on non-2xx', async () => {
    const { client } = createClient([
      { status: 409, body: { error: 'only claimed or running jobs report' } },
    ]);
    await expect(client.heartbeat('j1')).rejects.toThrow(
      /only claimed or running jobs report/,
    );
  });
});

describe('document', () => {
  it('fetches the bytes with the filename from content-disposition', async () => {
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // %PDF
    const calls: string[] = [];
    const client = makeSowerClient({
      base: 'https://api.example',
      token: 'k',
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        calls.push(String(input));
        const headers = (init?.headers ?? {}) as Record<string, string>;
        expect(headers['x-api-key']).toBe('k');
        return new Response(bytes, {
          status: 200,
          headers: {
            'content-type': 'application/pdf',
            'content-disposition': `attachment; filename="Transcript.pdf"; filename*=UTF-8''Transcript%20IBRAHEEM.pdf`,
          },
        });
      }) as typeof fetch,
    });
    const doc = await client.document('11111111-2222-4333-8444-555555555555');
    expect(calls).toEqual([
      'https://api.example/documents/11111111-2222-4333-8444-555555555555/content',
    ]);
    expect(doc.filename).toBe('Transcript IBRAHEEM.pdf');
    expect(doc.mimeType).toBe('application/pdf');
    expect([...doc.bytes]).toEqual([0x25, 0x50, 0x44, 0x46]);
  });

  it('surfaces a missing document as an error, not empty bytes', async () => {
    const client = makeSowerClient({
      base: 'https://api.example',
      token: 'k',
      fetch: (async () =>
        new Response('{"error":"document not found"}', {
          status: 404,
        })) as typeof fetch,
    });
    await expect(
      client.document('11111111-2222-4333-8444-555555555555'),
    ).rejects.toThrow(/HTTP 404/);
  });
});
