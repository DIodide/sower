/**
 * Capture a Workday candidate session for a tenant — the ATTENDED, residential
 * step of the "login once -> apply many over HTTP" architecture. Run LOCALLY on
 * a residential connection (your machine).
 *
 *   DATABASE_URL=... PROFILE_PATH=config/profile.yaml \
 *     pnpm --filter @sower/worker exec tsx scripts/workday-session-capture.ts \
 *       <tenant> <careers-or-login-url> [--proxy http://user:pass@host:port]
 *
 * Opens a headful stealth browser (optionally through a residential proxy),
 * lets YOU solve the captcha + sign in, then captures cookies + the browser
 * fingerprint, VERIFIES the session with a live calypso read, and stores it in
 * the vault. Nothing is submitted; this only establishes a session.
 */
import { createInterface } from 'node:readline/promises';
import { AccountManager } from '@sower/accounts';
import { loadProfile } from '@sower/answers';
import { createDb } from '@sower/db';
import { CalypsoClient, type WorkdaySession } from '@sower/platforms';
import { createStorage } from '@sower/storage';
import { SessionBroker } from '../src/workday/session-broker.js';
import { saveWorkdaySession } from '../src/workday/session-store.js';
import { createStealthBrowserLogin } from '../src/workday/stealth-login.js';

async function main(): Promise<void> {
  const tenant = process.argv[2];
  const url = process.argv[3];
  if (!tenant || !url) {
    console.error(
      'usage: workday-session-capture.ts <tenant> <careers-or-login-url> [--proxy <url>]',
    );
    process.exit(1);
  }
  const proxyIdx = process.argv.indexOf('--proxy');
  const proxyServer =
    proxyIdx !== -1
      ? process.argv[proxyIdx + 1]
      : process.env.SOWER_RESIDENTIAL_PROXY;
  const host = new URL(url).hostname;

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL is required (for the per-tenant account row).');
    process.exit(1);
  }
  const db = createDb(databaseUrl);
  const storage = createStorage();
  const accounts = new AccountManager(db, storage);
  const profile = loadProfile(
    process.env.PROFILE_PATH ?? 'config/profile.yaml',
  );

  // The credential to sign in with (provisioned + vaulted per tenant).
  const { credential } = await accounts.ensureAccount({
    platform: 'workday',
    tenant,
    email: profile.email,
  });
  console.log(
    `Account for ${tenant}: ${credential.email} (password is in the vault).`,
  );

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const broker = new SessionBroker({
    login: createStealthBrowserLogin({
      waitForHuman: async (prompt) => {
        await rl.question(prompt);
      },
    }),
    storeSession: (s: WorkdaySession) => saveWorkdaySession(storage, s),
    verify: (s: WorkdaySession) => new CalypsoClient(s).checkSession(),
  });

  try {
    const session = await broker.capture({
      host,
      tenant,
      loginUrl: url,
      credential: { email: credential.email, password: credential.password },
      proxyServer,
    });
    await accounts.setStatus('workday', tenant, 'verified');
    console.log(
      '\n✅ Session captured, VERIFIED with a live read, and stored.',
    );
    console.log(`   host:        ${session.host}`);
    console.log(`   cookies:     ${session.cookie.split(';').length}`);
    console.log(
      `   fingerprint: Chrome ${session.fingerprint?.chromeMajor ?? '?'} (${session.fingerprint?.userAgent?.slice(0, 40) ?? 'n/a'}…)`,
    );
    console.log(
      '   The calypso HTTP client can now drive applications for this tenant until the session expires (~30 min).',
    );
  } finally {
    rl.close();
  }
  process.exit(0);
}

main().catch((error) => {
  console.error('session capture failed:', error);
  process.exit(1);
});
