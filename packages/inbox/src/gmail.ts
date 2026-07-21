import {
  decodeBase64Url,
  extractOtpCode,
  extractVerificationLink,
} from './extract.js';
import type { InboxReader, OtpQuery, OtpResult } from './types.js';

/**
 * Gmail-API inbox reader (readonly scope) built on plain fetch — no
 * googleapis dependency. Auth is a long-lived OAuth refresh token obtained
 * once via `pnpm --filter @sower/inbox gmail-auth`; access tokens are minted
 * per ~55 minutes from it.
 */
export interface GmailConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

/** Read the Gmail config from env (GMAIL_CLIENT_ID/SECRET/REFRESH_TOKEN). */
export function gmailConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): GmailConfig | null {
  const clientId = env.GMAIL_CLIENT_ID ?? '';
  const clientSecret = env.GMAIL_CLIENT_SECRET ?? '';
  const refreshToken = env.GMAIL_REFRESH_TOKEN ?? '';
  if (!clientId || !clientSecret || !refreshToken) {
    return null;
  }
  return { clientId, clientSecret, refreshToken };
}

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';
/** Refresh 5 minutes before Google's ~60-minute expiry. */
const TOKEN_SLACK_MS = 5 * 60_000;

interface GmailMessageRef {
  id: string;
}

interface GmailHeader {
  name?: string;
  value?: string;
}

interface GmailMessagePart {
  mimeType?: string;
  headers?: GmailHeader[];
  body?: { data?: string };
  parts?: GmailMessagePart[];
}

interface GmailMessage {
  id: string;
  internalDate?: string;
  payload?: GmailMessagePart;
  snippet?: string;
}

/**
 * One message read for general scanning (the follow-up inbox poll): key
 * headers + every decoded text body joined into one blob.
 */
export interface GmailMessageSummary {
  id: string;
  subject: string;
  from: string;
  receivedAt: Date | null;
  bodyText: string;
}

/** Flatten a message's MIME tree into decoded text bodies (plain + html). */
export function collectBodies(payload: GmailMessagePart | undefined): string[] {
  if (!payload) return [];
  const bodies: string[] = [];
  const walk = (part: GmailMessagePart): void => {
    const data = part.body?.data;
    if (
      data &&
      (part.mimeType?.startsWith('text/') || part.mimeType === undefined)
    ) {
      bodies.push(decodeBase64Url(data));
    }
    for (const child of part.parts ?? []) {
      walk(child);
    }
  };
  walk(payload);
  return bodies;
}

/**
 * The Gmail search for a tenant's OTP mail: recent messages that look like a
 * verification email. Workday sender domains vary per tenant
 * (@myworkday.com, @<company>.com via their relay), so the query matches on
 * wording, restricted server-side to the window after `since`.
 */
export function buildSearchQuery(query: OtpQuery): string {
  const afterEpoch = Math.floor(query.since.getTime() / 1000);
  const terms = [
    `after:${afterEpoch}`,
    '("verification code" OR "security code" OR "one-time" OR "passcode" OR "verify your" OR "confirm your email" OR "activate")',
  ];
  return terms.join(' ');
}

export class GmailInboxReader implements InboxReader {
  private accessToken: string | null = null;
  private accessTokenExpiresAt = 0;

  constructor(
    private readonly config: GmailConfig,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  /** One search pass; null when no matching mail exists yet. */
  async findOtp(query: OtpQuery): Promise<OtpResult | null> {
    const token = await this.token();
    const q = buildSearchQuery(query);
    const listRes = await this.fetchImpl(
      `${GMAIL_BASE}/messages?maxResults=10&q=${encodeURIComponent(q)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!listRes.ok) {
      throw new Error(`gmail search failed with status ${listRes.status}`);
    }
    const list = (await listRes.json()) as { messages?: GmailMessageRef[] };
    // Newest first is Gmail's default ordering.
    for (const ref of list.messages ?? []) {
      const msgRes = await this.fetchImpl(
        `${GMAIL_BASE}/messages/${ref.id}?format=full`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (!msgRes.ok) {
        continue;
      }
      const message = (await msgRes.json()) as GmailMessage;
      const bodies = [...collectBodies(message.payload), message.snippet ?? ''];
      // Tenant filter is best-effort: prefer a body that names the tenant or
      // its host, but accept any OTP mail in the window (codes are scoped to
      // one sign-in attempt, and the window starts at the attempt).
      const tenantRe = new RegExp(query.tenant, 'i');
      const ranked = [...bodies].sort(
        (a, b) => Number(tenantRe.test(b)) - Number(tenantRe.test(a)),
      );
      for (const body of ranked) {
        const code = extractOtpCode(body);
        const verificationUrl = extractVerificationLink(body);
        if (code || verificationUrl) {
          return {
            code,
            verificationUrl,
            source: 'gmail',
            messageId: message.id,
            receivedAt: message.internalDate
              ? new Date(Number(message.internalDate))
              : null,
          };
        }
      }
    }
    return null;
  }

  /**
   * List the message ids matching a raw Gmail search query (newest first —
   * Gmail's default ordering). Throws on an API failure; an empty result is
   * simply [].
   */
  async searchMessageIds(query: string, maxResults = 25): Promise<string[]> {
    const token = await this.token();
    const listRes = await this.fetchImpl(
      `${GMAIL_BASE}/messages?maxResults=${maxResults}&q=${encodeURIComponent(query)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!listRes.ok) {
      throw new Error(`gmail search failed with status ${listRes.status}`);
    }
    const list = (await listRes.json()) as { messages?: GmailMessageRef[] };
    return (list.messages ?? []).map((ref) => ref.id);
  }

  /**
   * Fetch one message's headers + decoded text bodies. Null when the
   * message cannot be read (deleted, permission hiccup) — an unreadable
   * message is a skip for callers, never a batch failure.
   */
  async readMessage(id: string): Promise<GmailMessageSummary | null> {
    const token = await this.token();
    const msgRes = await this.fetchImpl(
      `${GMAIL_BASE}/messages/${id}?format=full`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!msgRes.ok) {
      return null;
    }
    const message = (await msgRes.json()) as GmailMessage;
    const headers = message.payload?.headers ?? [];
    const header = (name: string): string =>
      headers.find((h) => h.name?.toLowerCase() === name)?.value ?? '';
    const bodies = [...collectBodies(message.payload), message.snippet ?? ''];
    return {
      id: message.id,
      subject: header('subject'),
      from: header('from'),
      receivedAt: message.internalDate
        ? new Date(Number(message.internalDate))
        : null,
      bodyText: bodies.filter((body) => body.trim() !== '').join('\n'),
    };
  }

  /** Poll findOtp until a result or the timeout budget runs out. */
  async waitForOtp(query: OtpQuery): Promise<OtpResult | null> {
    const timeoutMs = query.timeoutMs ?? 120_000;
    const pollIntervalMs = query.pollIntervalMs ?? 5_000;
    const deadline = this.now() + timeoutMs;
    for (;;) {
      const result = await this.findOtp(query);
      if (result) {
        return result;
      }
      const remaining = deadline - this.now();
      if (remaining <= 0) {
        return null;
      }
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(pollIntervalMs, remaining)),
      );
    }
  }

  private async token(): Promise<string> {
    if (this.accessToken && this.now() < this.accessTokenExpiresAt) {
      return this.accessToken;
    }
    const res = await this.fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        refresh_token: this.config.refreshToken,
        grant_type: 'refresh_token',
      }).toString(),
    });
    if (!res.ok) {
      throw new Error(
        `gmail token refresh failed with status ${res.status} (re-run gmail-auth if the refresh token was revoked)`,
      );
    }
    const body = (await res.json()) as {
      access_token: string;
      expires_in?: number;
    };
    this.accessToken = body.access_token;
    this.accessTokenExpiresAt =
      this.now() + (body.expires_in ?? 3600) * 1000 - TOKEN_SLACK_MS;
    return this.accessToken;
  }
}
