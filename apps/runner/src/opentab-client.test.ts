import { describe, expect, it } from 'vitest';
import { makeOpenTabClient, type OpenTabSession } from './opentab-client.js';

/**
 * Session create/destroy against an injected fetch, parsing the exact
 * SessionResponse shape OpenTab's src/types.ts declares (urls included).
 */

const TOKEN = 'ot-serve-token';
const BASE = 'http://127.0.0.1:9333';

// Field names copied from OpenTab types.ts: SessionResponse = SessionInfo + urls.
const session: OpenTabSession = {
  id: 's_ab12cd',
  isolation: 'context',
  profile: 'default',
  headless: true,
  instanceId: 'i_default_headless',
  targetId: 'F0A1B2C3D4E5',
  browserContextId: 'CTX42',
  url: 'https://job-boards.greenhouse.io/acme/jobs/123',
  createdAt: '2026-08-28T00:00:00.000Z',
  expiresAt: null,
  urls: {
    cdp_ws: 'ws://127.0.0.1:9333/t/ot-serve-token/s/s_ab12cd',
    browser_http: 'http://127.0.0.1:9333/t/ot-serve-token/i/i_default_headless',
    browser_ws:
      'ws://127.0.0.1:9333/t/ot-serve-token/i/i_default_headless/devtools/browser/uuid-1234',
    devtools:
      'http://127.0.0.1:9333/t/ot-serve-token/devtools-frontend/@abc123/inspector.html?ws=127.0.0.1:9333/t/ot-serve-token/s/s_ab12cd',
    live_view: 'http://127.0.0.1:9333/t/ot-serve-token/view/s/s_ab12cd',
  },
};

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
  const client = makeOpenTabClient({
    base: BASE,
    token: TOKEN,
    fetch: fetchStub,
  });
  return { client, requests };
}

describe('makeOpenTabClient', () => {
  it('createSession: POST /api/sessions with a bearer token, parsed to the real shape', async () => {
    const { client, requests } = createClient([{ body: session }]);
    const created = await client.createSession({
      isolation: 'context',
      headless: true,
      url: session.url,
      ttl: 14400,
    });
    expect(requests[0]?.url).toBe(`${BASE}/api/sessions`);
    expect(requests[0]?.method).toBe('POST');
    expect(requests[0]?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(requests[0]?.body).toEqual({
      isolation: 'context',
      headless: true,
      url: session.url,
      ttl: 14400,
    });
    expect(created).toEqual(session);
    expect(created.urls.browser_http).toBe(session.urls.browser_http);
    expect(created.urls.devtools).toBe(session.urls.devtools);
    expect(created.urls.cdp_ws).toBe(session.urls.cdp_ws);
    expect(created.targetId).toBe('F0A1B2C3D4E5');
  });

  it('destroySession: DELETE /api/sessions/:id', async () => {
    const { client, requests } = createClient([{ body: { ok: true } }]);
    await client.destroySession('s_ab12cd');
    expect(requests[0]?.url).toBe(`${BASE}/api/sessions/s_ab12cd`);
    expect(requests[0]?.method).toBe('DELETE');
  });

  it('surfaces the api error message on non-2xx', async () => {
    const { client } = createClient([
      { status: 404, body: { error: 'no such session: s_dead00' } },
    ]);
    await expect(client.destroySession('s_dead00')).rejects.toThrow(
      /no such session/,
    );
  });
});
