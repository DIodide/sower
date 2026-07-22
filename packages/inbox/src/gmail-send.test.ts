import { describe, expect, it, vi } from 'vitest';
import {
  buildMimeMessage,
  encodeHeaderValue,
  GmailSendScopeError,
  sendGmailMessage,
} from './gmail-send.js';

const config = {
  clientId: 'cid',
  clientSecret: 'csec',
  refreshToken: 'rtok',
};

const message = {
  to: 'me@example.com',
  subject: 'Sower weekly',
  html: '<p>hello</p>',
  text: 'hello',
};

/** One recorded send-endpoint call (the token request is filtered out). */
interface SendCall {
  url: string;
  headers: Record<string, string>;
  body: string;
}

/** fetch mock: serves the token endpoint, records + answers the send. */
function createSendFetch(sendResponse: Response) {
  const calls: SendCall[] = [];
  const tokenBodies: string[] = [];
  const fetchFn = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('https://oauth2.googleapis.com/token')) {
        tokenBodies.push(String(init?.body ?? ''));
        return new Response(
          JSON.stringify({ access_token: 'at-1', expires_in: 3600 }),
          { status: 200 },
        );
      }
      calls.push({
        url,
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: String(init?.body ?? ''),
      });
      return sendResponse;
    },
  ) as unknown as typeof fetch;
  return { fetchFn, calls, tokenBodies };
}

describe('encodeHeaderValue', () => {
  it('passes plain ASCII through unchanged', () => {
    expect(encodeHeaderValue('Sower weekly - 4 sent')).toBe(
      'Sower weekly - 4 sent',
    );
  });

  it('RFC-2047-encodes non-ASCII (the em dash the subject carries)', () => {
    const encoded = encodeHeaderValue('Sower weekly — 4 sent');
    expect(encoded).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
    const b64 = encoded.slice('=?UTF-8?B?'.length, -'?='.length);
    expect(Buffer.from(b64, 'base64').toString('utf8')).toBe(
      'Sower weekly — 4 sent',
    );
  });
});

describe('buildMimeMessage', () => {
  it('builds a multipart/alternative message: text/plain first, then text/html', () => {
    const mime = buildMimeMessage(message);
    expect(mime).toContain('From: me\r\n');
    expect(mime).toContain('To: me@example.com\r\n');
    expect(mime).toContain('Subject: Sower weekly\r\n');
    expect(mime).toContain('Content-Type: multipart/alternative; boundary=');
    expect(mime.indexOf('text/plain')).toBeLessThan(mime.indexOf('text/html'));
    // Both parts base64-decode back to the exact inputs.
    const bodies = [...mime.matchAll(/\r\n\r\n([A-Za-z0-9+/=\r\n]+)\r\n--/g)]
      .map((match) => match[1] ?? '')
      .map((b64) => Buffer.from(b64.replace(/\r\n/g, ''), 'base64'))
      .map((buf) => buf.toString('utf8'));
    expect(bodies).toEqual(['hello', '<p>hello</p>']);
  });

  it('folds long base64 bodies to 76-char lines', () => {
    const mime = buildMimeMessage({ ...message, text: 'x'.repeat(600) });
    const long = mime
      .split('\r\n')
      .filter((line) => /^[A-Za-z0-9+/=]+$/.test(line));
    expect(long.length).toBeGreaterThan(1);
    for (const line of long) {
      expect(line.length).toBeLessThanOrEqual(76);
    }
  });
});

describe('sendGmailMessage', () => {
  it('mints a token from the refresh token and POSTs the base64url message', async () => {
    const { fetchFn, calls, tokenBodies } = createSendFetch(
      new Response(JSON.stringify({ id: 'sent-1' }), { status: 200 }),
    );

    const result = await sendGmailMessage(config, message, fetchFn);

    expect(result).toEqual({ id: 'sent-1' });
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.url).toBe(
      'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
    );
    expect(call?.headers.Authorization).toBe('Bearer at-1');
    const { raw } = JSON.parse(call?.body ?? '{}') as { raw: string };
    // base64url round-trips to the exact MIME message.
    expect(Buffer.from(raw, 'base64url').toString('utf8')).toBe(
      buildMimeMessage(message),
    );
    // The token request carried the refresh grant.
    expect(tokenBodies[0]).toContain('grant_type=refresh_token');
    expect(tokenBodies[0]).toContain('refresh_token=rtok');
  });

  it('throws the distinct scope error on a 403 (token lacks gmail.send)', async () => {
    const { fetchFn } = createSendFetch(new Response('{}', { status: 403 }));
    const attempt = sendGmailMessage(config, message, fetchFn);
    await expect(attempt).rejects.toBeInstanceOf(GmailSendScopeError);
    await expect(sendGmailMessage(config, message, fetchFn)).rejects.toThrow(
      /gmail\.send scope/,
    );
  });

  it('throws a status-only error on any other send failure (no token, no body)', async () => {
    const { fetchFn } = createSendFetch(new Response('{}', { status: 500 }));
    const error = await sendGmailMessage(config, message, fetchFn).catch(
      (caught: Error) => caught,
    );
    expect(String(error)).toMatch(/gmail send failed with status 500/);
    expect(String(error)).not.toContain('at-1');
    expect(String(error)).not.toContain('rtok');
    expect(String(error)).not.toContain('hello');
  });

  it('throws the actionable refresh error when the token mint fails', async () => {
    const fetchFn = vi.fn(
      async () => new Response('{}', { status: 400 }),
    ) as unknown as typeof fetch;
    await expect(sendGmailMessage(config, message, fetchFn)).rejects.toThrow(
      /re-run gmail-auth/,
    );
  });

  it('propagates a network failure', async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error('ECONNRESET');
    }) as unknown as typeof fetch;
    await expect(sendGmailMessage(config, message, fetchFn)).rejects.toThrow(
      'ECONNRESET',
    );
  });
});
