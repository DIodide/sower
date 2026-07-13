/**
 * Post-consent smoke test: search the last hour of mail for an OTP-looking
 * message the way the browser tier will.
 *
 *   GMAIL_CLIENT_ID=... GMAIL_CLIENT_SECRET=... GMAIL_REFRESH_TOKEN=... \
 *     pnpm --filter @sower/inbox otp-check [tenant]
 */
import { GmailInboxReader, gmailConfigFromEnv } from '../src/index.js';

const config = gmailConfigFromEnv();
if (!config) {
  console.error(
    'Set GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, and GMAIL_REFRESH_TOKEN, then re-run.',
  );
  process.exit(1);
}

const tenant = process.argv[2] ?? 'workday';
const reader = new GmailInboxReader(config);
reader
  .findOtp({ tenant, since: new Date(Date.now() - 60 * 60_000) })
  .then((result) => {
    if (!result) {
      console.log(
        `No OTP/verification email in the last hour for tenant "${tenant}" — that's expected unless a sign-in was just attempted.`,
      );
      return;
    }
    console.log('Found:', {
      code: result.code,
      verificationUrl: result.verificationUrl,
      messageId: result.messageId,
      receivedAt: result.receivedAt?.toISOString(),
    });
  })
  .catch((error) => {
    console.error('Gmail check failed:', error.message);
    process.exitCode = 1;
  });
