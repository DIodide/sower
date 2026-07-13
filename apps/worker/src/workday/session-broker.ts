import {
  CalypsoClient,
  type WorkdaySession,
  type WorkdaySessionFingerprint,
} from '@sower/platforms';
import {
  type BrowserCookie,
  captureWorkdaySession,
} from './session-capture.js';

/**
 * The Workday session broker: run the reCAPTCHA-gated candidate login ONCE per
 * tenant in a residential browser, capture the session, VERIFY it with a live
 * read, and store it — so the calypso HTTP client can then drive applications
 * without a browser. This confines the captcha/anti-bot problem to a rare,
 * human/residential step.
 *
 * DESIGN (per project caution — never trust a single capture):
 *  login (browser, residential) -> capture cookies -> assert authenticated ->
 *  VERIFY with a live calypso read -> only then store.
 * The browser login is injected (`login`), so this orchestration is unit
 * testable without a browser, a proxy, or a network.
 */

/** What the residential-browser login returns after a completed sign-in. */
export interface BrowserLoginResult {
  cookies: BrowserCookie[];
  /** The capturing browser's fingerprint, for HTTP-replay impersonation. */
  fingerprint?: WorkdaySessionFingerprint;
}

/** Drives the login in a residential browser and returns its cookies. */
export type BrowserLogin = (input: {
  host: string;
  tenant: string;
  /** The tenant career-site URL to start the login from. */
  loginUrl: string;
  credential: { email: string; password: string };
  /** Residential proxy egress, e.g. 'http://user:pass@host:port'. */
  proxyServer?: string;
}) => Promise<BrowserLoginResult>;

export interface SessionBrokerDeps {
  /** The residential-browser login step (the only captcha-exposed piece). */
  login: BrowserLogin;
  /** Persist a verified session (default: the vault store). */
  storeSession: (session: WorkdaySession) => Promise<void>;
  /**
   * Verify a captured session with a live read. Defaults to
   * CalypsoClient.checkSession — overridable for tests/proxying.
   */
  verify?: (session: WorkdaySession) => Promise<boolean>;
  /** ISO clock (injectable for tests). */
  now?: () => string;
}

export interface CaptureInput {
  host: string;
  tenant: string;
  loginUrl: string;
  credential: { email: string; password: string };
  proxyServer?: string;
}

/** Thrown when a freshly-captured session fails its live verification. */
export class SessionVerificationFailedError extends Error {
  constructor(tenant: string) {
    super(
      `captured workday session for '${tenant}' failed live verification — not stored (login may have tripped anti-bot, or the session is already dead)`,
    );
    this.name = 'SessionVerificationFailedError';
  }
}

export class SessionBroker {
  constructor(private readonly deps: SessionBrokerDeps) {}

  /**
   * Capture, verify, and store a session for a tenant. Throws (without
   * storing) if the cookies are not an authenticated session
   * (NotAuthenticatedSessionError) or if verification fails
   * (SessionVerificationFailedError).
   */
  async capture(input: CaptureInput): Promise<WorkdaySession> {
    const { cookies, fingerprint } = await this.deps.login(input);

    const now = this.deps.now ?? (() => new Date().toISOString());
    // Throws NotAuthenticatedSessionError if the login did not complete.
    const session = captureWorkdaySession(
      input.host,
      input.tenant,
      cookies,
      now(),
      fingerprint,
    );

    const verify =
      this.deps.verify ??
      ((s: WorkdaySession) => new CalypsoClient(s).checkSession());
    if (!(await verify(session))) {
      throw new SessionVerificationFailedError(input.tenant);
    }

    await this.deps.storeSession(session);
    return session;
  }
}
