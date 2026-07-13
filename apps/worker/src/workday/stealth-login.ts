import {
  chromeMajorFromUserAgent,
  type WorkdaySessionFingerprint,
} from '@sower/platforms';
import { type Browser, chromium, type Page } from 'playwright';
import { anyAutomationId, automationId, WORKDAY_IDS } from './selectors.js';
import type { BrowserLogin, BrowserLoginResult } from './session-broker.js';

/**
 * The residential-browser attended login (the one reCAPTCHA-gated step).
 *
 * ATTENDED by design: launches a headful, lightly-hardened Chromium (optionally
 * through a residential proxy PER CONTEXT), warms the careers page so Cloudflare
 * JS + the invisible reCAPTCHA run naturally, pre-fills ONLY the visible,
 * labeled email/password fields, then WAITS for the human to solve the captcha
 * and finish signing in. On confirmation it snapshots the cookies + the browser
 * fingerprint (so the HTTP replay impersonates the same Chrome).
 *
 * DEFENSIVE (per workday-browser-tier.md): never enumerate-and-fill inputs —
 * only the specific email/password automation-ids are touched — and it ASSERTS
 * the `beecatcher` honeypot stayed empty before trusting the capture.
 *
 * Stealth is intentionally LIGHT (stock Playwright + webdriver hiding + realistic
 * context) because the human solving the captcha dominates the reCAPTCHA score.
 * `launchBrowser` is injectable so a patched build (patchright/Camoufox) can be
 * dropped in for a tenant that still challenges.
 */

export interface StealthLoginDeps {
  /**
   * Optional attended confirm (e.g. read a line from the terminal). When
   * omitted, login completion is AUTO-DETECTED by polling for the authenticated
   * session cookie + the sign-in form clearing — so the flow works even when a
   * program (not a person at this terminal) launched the browser and only a
   * human at the SCREEN interacts with it.
   */
  waitForHuman?: (prompt: string) => Promise<void>;
  /** Launch a browser (default: headful Playwright chromium with stealth args). */
  launchBrowser?: (proxyServer?: string) => Promise<Browser>;
  /** Progress logger (default: console.log). */
  log?: (message: string) => void;
  /** Max wait for login when auto-detecting (default 8 min). */
  loginTimeoutMs?: number;
}

/** The cookie whose presence marks a completed candidate login. */
const AUTH_SESSION_COOKIE = 'CALYPSO_SESSION';

const STEALTH_ARGS = [
  '--disable-blink-features=AutomationControlled',
  '--disable-features=IsolateOrigins,site-per-process',
];

/**
 * Auto-detect a completed candidate login: poll until the authenticated
 * session cookie is present AND the sign-in password field is gone. The
 * verify-before-store step in SessionBroker is the safety net if this fires a
 * touch early. Throws on timeout.
 */
async function waitForLogin(page: Page, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const context = page.context();
  while (Date.now() < deadline) {
    await page.waitForTimeout(3_000).catch(() => {});
    const cookies = await context.cookies().catch(() => []);
    if (!cookies.some((c) => c.name === AUTH_SESSION_COOKIE)) {
      continue;
    }
    const passwordVisible = await page
      .locator(anyAutomationId(WORKDAY_IDS.password))
      .first()
      .isVisible({ timeout: 1_000 })
      .catch(() => false);
    if (!passwordVisible) {
      return;
    }
  }
  throw new Error(
    `timed out after ~${Math.round(timeoutMs / 60_000)} min waiting for login (no ${AUTH_SESSION_COOKIE} + cleared sign-in form)`,
  );
}

async function defaultLaunch(proxyServer?: string): Promise<Browser> {
  return chromium.launch({
    headless: false,
    args: STEALTH_ARGS,
    ...(proxyServer ? { proxy: { server: proxyServer } } : {}),
  });
}

export function createStealthBrowserLogin(
  deps: StealthLoginDeps,
): BrowserLogin {
  const launch = deps.launchBrowser ?? defaultLaunch;
  const log = deps.log ?? ((m: string) => console.log(m));

  return async (input): Promise<BrowserLoginResult> => {
    const browser = await launch(input.proxyServer);
    try {
      const context = await browser.newContext({
        locale: 'en-US',
        timezoneId: 'America/New_York',
        viewport: { width: 1280, height: 820 },
        // Per-context proxy keeps ONE sticky residential IP for this login.
        ...(input.proxyServer ? { proxy: { server: input.proxyServer } } : {}),
      });
      // Hide the most obvious automation tell before any page script runs.
      await context.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', {
          get: () => undefined,
        });
      });
      const page = await context.newPage();

      // WARM: load the login page and let Cloudflare/reCAPTCHA execute.
      log(`Opening ${input.loginUrl} …`);
      await page.goto(input.loginUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 30_000,
      });
      await page
        .waitForLoadState('networkidle', { timeout: 10_000 })
        .catch(() => {});

      // Pre-fill ONLY the visible, labeled credential fields (never scan-and-fill).
      const emailField = page
        .locator(anyAutomationId(WORKDAY_IDS.email))
        .first();
      if (await emailField.isVisible({ timeout: 3_000 }).catch(() => false)) {
        await emailField.fill(input.credential.email).catch(() => {});
      }
      const pwField = page
        .locator(anyAutomationId(WORKDAY_IDS.password))
        .first();
      if (await pwField.isVisible({ timeout: 3_000 }).catch(() => false)) {
        await pwField.fill(input.credential.password).catch(() => {});
      }

      // Hand control to the human for the captcha + submit — either a terminal
      // confirm, or (default) auto-detect that login completed.
      if (deps.waitForHuman) {
        await deps.waitForHuman(
          `\n>>> Solve the captcha + sign in for '${input.tenant}', then press Enter here… `,
        );
      } else {
        log(
          `A browser window is open. Solve the captcha and sign in (or create the account) for '${input.tenant}' and reach the candidate home — I'll capture automatically once you're logged in.`,
        );
        await waitForLogin(page, deps.loginTimeoutMs ?? 8 * 60_000);
      }

      // DEFENSIVE: the beecatcher honeypot must be empty — a filled one means
      // something scanned-and-filled the form; refuse to trust this capture.
      const honeypot = await page
        .locator(automationId('beecatcher'))
        .first()
        .inputValue()
        .catch(() => '');
      if (honeypot.trim() !== '') {
        throw new Error(
          'beecatcher honeypot was filled — aborting capture to avoid a bot flag',
        );
      }

      // CAPTURE cookies + fingerprint.
      const cookies = (await context.cookies()).map((c) => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
      }));
      const userAgent = await page
        .evaluate(() => navigator.userAgent)
        .catch(() => undefined);
      const acceptLanguage = await page
        .evaluate(() =>
          Array.isArray(navigator.languages)
            ? navigator.languages.join(',')
            : navigator.language,
        )
        .catch(() => undefined);
      const fingerprint: WorkdaySessionFingerprint = {
        userAgent,
        chromeMajor: chromeMajorFromUserAgent(userAgent),
        acceptLanguage,
      };

      log(`Captured ${cookies.length} cookies for ${input.tenant}.`);
      return { cookies, fingerprint };
    } finally {
      await browser.close().catch(() => {});
    }
  };
}
