import {
  chromeMajorFromUserAgent,
  type WorkdaySessionFingerprint,
} from '@sower/platforms';
import { type Browser, chromium } from 'playwright';
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
   * Blocks until the human signals login is complete (e.g. reads a line from
   * the terminal). Required — this flow is attended.
   */
  waitForHuman: (prompt: string) => Promise<void>;
  /** Launch a browser (default: headful Playwright chromium with stealth args). */
  launchBrowser?: (proxyServer?: string) => Promise<Browser>;
  /** Progress logger (default: console.log). */
  log?: (message: string) => void;
}

const STEALTH_ARGS = [
  '--disable-blink-features=AutomationControlled',
  '--disable-features=IsolateOrigins,site-per-process',
];

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

      // ATTENDED: hand control to the human for the captcha + submit.
      await deps.waitForHuman(
        `\n>>> In the browser: solve the captcha, complete sign-in (or create the account), reach the candidate home / application, THEN press Enter here to capture the session for '${input.tenant}'… `,
      );

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
