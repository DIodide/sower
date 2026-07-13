import type {
  WorkdaySession,
  WorkdaySessionFingerprint,
} from '@sower/platforms';

/**
 * Turning a browser's cookies into a replayable Workday session.
 *
 * The reCAPTCHA-gated login runs in a real (residential) browser; afterward we
 * snapshot the cookies and build the `WorkdaySession` the calypso HTTP client
 * replays. The `x-calypso-csrf-token` header mirrors the `CALYPSO_CSRF_TOKEN`
 * cookie (double-submit), so it is derived here — not guessed.
 *
 * CAUTION (per project guidance): a single captured session is NOT proof the
 * flow is safe — Workday has honeypots and anti-bot signals a lone human HAR
 * never reveals. So capture only asserts the session LOOKS authenticated; the
 * broker must then VERIFY it with a live read before trusting/storing it.
 */

/** The subset of a Playwright cookie this needs. */
export interface BrowserCookie {
  name: string;
  value: string;
  domain?: string;
}

/** Cookies that must be present for a session to look authenticated. */
const AUTH_COOKIES = ['PLAY_SESSION', 'CALYPSO_SESSION'];
const CSRF_COOKIE = 'CALYPSO_CSRF_TOKEN';

export class NotAuthenticatedSessionError extends Error {
  constructor(missing: string) {
    super(
      `captured cookies are not an authenticated Workday session (missing ${missing}) — the login likely did not complete`,
    );
    this.name = 'NotAuthenticatedSessionError';
  }
}

/**
 * Build a WorkdaySession from a browser's cookies. Throws
 * NotAuthenticatedSessionError when the cookies do not look like a completed
 * candidate login (so a captcha-blocked or half-finished login can never be
 * stored as a working session).
 */
export function captureWorkdaySession(
  host: string,
  tenant: string,
  cookies: BrowserCookie[],
  capturedAt: string,
  fingerprint?: WorkdaySessionFingerprint,
): WorkdaySession {
  const byName = new Map(cookies.map((c) => [c.name, c.value] as const));

  const csrf = byName.get(CSRF_COOKIE);
  if (!csrf) {
    throw new NotAuthenticatedSessionError(CSRF_COOKIE);
  }
  // At least one true auth-session cookie must be present.
  if (!AUTH_COOKIES.some((name) => byName.has(name))) {
    throw new NotAuthenticatedSessionError(AUTH_COOKIES.join(' or '));
  }

  // Serialize every cookie into a Cookie header (Cloudflare's __cf_bm etc.
  // must be carried too — dropping them can trip bot management on replay).
  const cookie = cookies
    .filter((c) => c.name && c.value !== undefined)
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');

  const session: WorkdaySession = {
    host,
    tenant,
    cookie,
    csrfToken: csrf,
    capturedAt,
  };
  if (fingerprint && Object.keys(fingerprint).length > 0) {
    session.fingerprint = fingerprint;
  }
  return session;
}

/**
 * Whether a stored session is within its freshness window. Workday sessions
 * (and Cloudflare's __cf_bm) are short-lived — an expired session returns 500
 * rather than 401, so we refresh proactively by age instead of by status.
 */
export function isSessionFresh(
  session: Pick<WorkdaySession, 'capturedAt'>,
  now: number,
  maxAgeMs = 20 * 60_000,
): boolean {
  if (!session.capturedAt) {
    return false;
  }
  const captured = Date.parse(session.capturedAt);
  if (Number.isNaN(captured)) {
    return false;
  }
  return now - captured < maxAgeMs;
}
