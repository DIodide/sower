import type { GmailConfig } from './gmail.js';

/**
 * Gmail-API sender (gmail.send scope) built on plain fetch — no googleapis
 * dependency, mirroring gmail.ts. Auth mints a fresh access token per send
 * from the same long-lived refresh token the reader uses (a weekly send
 * needs no token cache). SECRETS: the tokens and the message content are
 * never logged — every error carries an HTTP status only.
 */

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SEND_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';

/** One outgoing message: multipart/alternative text + html to one address. */
export interface OutgoingGmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
}

/**
 * The send endpoint answered 403: the refresh token was minted without the
 * gmail.send scope (the reader's readonly scope cannot send). Distinct so a
 * caller can report "email skipped: token lacks send scope" instead of a
 * generic failure. Fix: re-run gmail-auth requesting the send scope.
 */
export class GmailSendScopeError extends Error {
  constructor() {
    super(
      'gmail send was refused (403): the refresh token lacks the gmail.send scope (re-run gmail-auth with the send scope)',
    );
    this.name = 'GmailSendScopeError';
  }
}

/**
 * RFC 2047 encoded-word for a header value: plain ASCII passes through
 * unchanged; anything else (an em dash, an emoji) becomes =?UTF-8?B?…?=.
 */
export function encodeHeaderValue(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value)) {
    return value;
  }
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

/** RFC 2045 base64 body: UTF-8 bytes, folded to 76-char lines with CRLF. */
function base64Body(text: string): string {
  const encoded = Buffer.from(text, 'utf8').toString('base64');
  return encoded.replace(/(.{76})(?=.)/g, '$1\r\n');
}

/**
 * MIME boundary. Deterministic on purpose: both parts are base64-encoded,
 * and no line of valid base64 can start with `--` — the boundary can never
 * collide with body content, so nothing random is needed.
 */
const MIME_BOUNDARY = '=_sower_digest_boundary_=';

/**
 * The full RFC 2822 message: From "me" (Gmail substitutes the account),
 * multipart/alternative with the text/plain part FIRST and text/html last —
 * RFC 2046 orders alternatives from least to most preferred.
 */
export function buildMimeMessage(msg: OutgoingGmailMessage): string {
  return [
    'From: me',
    `To: ${msg.to}`,
    `Subject: ${encodeHeaderValue(msg.subject)}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${MIME_BOUNDARY}"`,
    '',
    `--${MIME_BOUNDARY}`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Body(msg.text),
    `--${MIME_BOUNDARY}`,
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Body(msg.html),
    `--${MIME_BOUNDARY}--`,
    '',
  ].join('\r\n');
}

/**
 * Send one message as the authenticated user. Refresh-token → access token
 * exactly like the reader, then POST the base64url-encoded RFC 2822 message
 * to users/me/messages/send. Throws GmailSendScopeError on a 403 (token
 * minted without gmail.send) and a status-only Error on any other failure —
 * never the token, never the message body.
 */
export async function sendGmailMessage(
  config: GmailConfig,
  msg: OutgoingGmailMessage,
  fetchFn: typeof fetch = fetch,
): Promise<{ id: string }> {
  const tokenRes = await fetchFn(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: config.refreshToken,
      grant_type: 'refresh_token',
    }).toString(),
  });
  if (!tokenRes.ok) {
    throw new Error(
      `gmail token refresh failed with status ${tokenRes.status} (re-run gmail-auth if the refresh token was revoked)`,
    );
  }
  const token = (await tokenRes.json()) as { access_token: string };

  const raw = Buffer.from(buildMimeMessage(msg), 'utf8').toString('base64url');
  const sendRes = await fetchFn(SEND_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token.access_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ raw }),
  });
  if (sendRes.status === 403) {
    // The one 403 this endpoint produces in practice: the token's scopes
    // don't include gmail.send (the reader's token is readonly).
    throw new GmailSendScopeError();
  }
  if (!sendRes.ok) {
    throw new Error(`gmail send failed with status ${sendRes.status}`);
  }
  const body = (await sendRes.json()) as { id?: string };
  return { id: body.id ?? '' };
}
