import { describe, expect, it, vi } from 'vitest';
import {
  buildSearchQuery,
  collectBodies,
  GmailInboxReader,
  gmailConfigFromEnv,
} from './gmail.js';

const config = {
  clientId: 'cid',
  clientSecret: 'csec',
  refreshToken: 'rtok',
};

function b64url(text: string): string {
  return Buffer.from(text, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

/** fetch mock covering token refresh + message list + message get. */
function createGmailFetch(options: {
  messages: Array<{ id: string; body: string; internalDate?: string }>;
  tokenCalls?: { count: number };
}) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith('https://oauth2.googleapis.com/token')) {
      if (options.tokenCalls) options.tokenCalls.count += 1;
      return new Response(
        JSON.stringify({ access_token: 'at-1', expires_in: 3600 }),
        { status: 200 },
      );
    }
    if (url.includes('/messages?')) {
      return new Response(
        JSON.stringify({
          messages: options.messages.map((m) => ({ id: m.id })),
        }),
        { status: 200 },
      );
    }
    const match = url.match(/\/messages\/([^?]+)/);
    const message = options.messages.find((m) => m.id === match?.[1]);
    if (!message) {
      return new Response('{}', { status: 404 });
    }
    return new Response(
      JSON.stringify({
        id: message.id,
        internalDate: message.internalDate ?? '1782000000000',
        payload: {
          mimeType: 'multipart/alternative',
          parts: [
            { mimeType: 'text/plain', body: { data: b64url(message.body) } },
          ],
        },
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
}

const query = { tenant: 'cadence', since: new Date('2026-07-12T00:00:00Z') };

describe('gmailConfigFromEnv', () => {
  it('returns null unless all three vars are set', () => {
    expect(gmailConfigFromEnv({})).toBeNull();
    expect(gmailConfigFromEnv({ GMAIL_CLIENT_ID: 'a' })).toBeNull();
    expect(
      gmailConfigFromEnv({
        GMAIL_CLIENT_ID: 'a',
        GMAIL_CLIENT_SECRET: 'b',
        GMAIL_REFRESH_TOKEN: 'c',
      }),
    ).toEqual({ clientId: 'a', clientSecret: 'b', refreshToken: 'c' });
  });
});

describe('buildSearchQuery', () => {
  it('bounds the search to the sign-in attempt window', () => {
    const q = buildSearchQuery(query);
    expect(q).toContain(`after:${Math.floor(query.since.getTime() / 1000)}`);
    expect(q).toContain('verification code');
  });
});

describe('collectBodies', () => {
  it('walks nested MIME parts and decodes each text body', () => {
    const bodies = collectBodies({
      mimeType: 'multipart/mixed',
      parts: [
        { mimeType: 'text/plain', body: { data: b64url('plain part') } },
        {
          mimeType: 'multipart/alternative',
          parts: [
            { mimeType: 'text/html', body: { data: b64url('<b>html</b>') } },
          ],
        },
        { mimeType: 'application/pdf', body: { data: b64url('%PDF') } },
      ],
    });
    expect(bodies).toEqual(['plain part', '<b>html</b>']);
  });
});

describe('GmailInboxReader.findOtp', () => {
  it('returns the code from a matching message', async () => {
    const fetchMock = createGmailFetch({
      messages: [
        {
          id: 'm1',
          body: 'Cadence Candidate Home: your verification code is 482913.',
        },
      ],
    });
    const reader = new GmailInboxReader(config, fetchMock);

    const result = await reader.findOtp(query);

    expect(result).toMatchObject({
      code: '482913',
      source: 'gmail',
      messageId: 'm1',
    });
  });

  it('skips codeless messages and finds a later match', async () => {
    const fetchMock = createGmailFetch({
      messages: [
        { id: 'm1', body: 'Thanks for your interest in Cadence!' },
        { id: 'm2', body: 'Your one-time passcode is 771034.' },
      ],
    });
    const result = await new GmailInboxReader(config, fetchMock).findOtp(query);
    expect(result?.messageId).toBe('m2');
    expect(result?.code).toBe('771034');
  });

  it('returns a verification link when the mail has a link but no code', async () => {
    const fetchMock = createGmailFetch({
      messages: [
        {
          id: 'm1',
          body: 'Please verify: https://cadence.wd1.myworkdayjobs.com/wday/verifyEmail?token=abc',
        },
      ],
    });
    const result = await new GmailInboxReader(config, fetchMock).findOtp(query);
    expect(result?.code).toBeNull();
    expect(result?.verificationUrl).toContain('verifyEmail');
  });

  it('returns null when nothing matches', async () => {
    const fetchMock = createGmailFetch({ messages: [] });
    expect(
      await new GmailInboxReader(config, fetchMock).findOtp(query),
    ).toBeNull();
  });

  it('caches the access token across calls', async () => {
    const tokenCalls = { count: 0 };
    const fetchMock = createGmailFetch({ messages: [], tokenCalls });
    const reader = new GmailInboxReader(config, fetchMock);

    await reader.findOtp(query);
    await reader.findOtp(query);

    expect(tokenCalls.count).toBe(1);
  });

  it('throws a actionable error when the refresh token is revoked', async () => {
    const fetchMock = vi.fn(
      async () => new Response('{}', { status: 400 }),
    ) as unknown as typeof fetch;
    await expect(
      new GmailInboxReader(config, fetchMock).findOtp(query),
    ).rejects.toThrow(/re-run gmail-auth/);
  });
});

describe('GmailInboxReader.waitForOtp', () => {
  it('polls until a message appears', async () => {
    const messages: Array<{ id: string; body: string }> = [];
    const fetchMock = createGmailFetch({ messages });
    const reader = new GmailInboxReader(config, fetchMock);

    const pending = reader.waitForOtp({
      ...query,
      timeoutMs: 500,
      pollIntervalMs: 10,
    });
    // The mail "arrives" while we're polling.
    setTimeout(() => {
      messages.push({ id: 'm9', body: 'Your verification code is 314159.' });
    }, 30);

    const result = await pending;
    expect(result?.code).toBe('314159');
  });

  it('gives up after the timeout budget', async () => {
    const fetchMock = createGmailFetch({ messages: [] });
    const reader = new GmailInboxReader(config, fetchMock);
    const result = await reader.waitForOtp({
      ...query,
      timeoutMs: 50,
      pollIntervalMs: 10,
    });
    expect(result).toBeNull();
  });
});
