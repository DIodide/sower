/**
 * One-time Gmail OAuth consent (loopback flow) — run LOCALLY, never deployed.
 *
 *   GMAIL_CLIENT_ID=... GMAIL_CLIENT_SECRET=... pnpm --filter @sower/inbox gmail-auth
 *
 * Starts a listener on 127.0.0.1:8765, prints a consent URL to open in the
 * browser, catches Google's redirect, exchanges the code, and prints the
 * GMAIL_REFRESH_TOKEN to store as a secret. Scope is gmail.readonly — the
 * system can only ever READ mail, never send or delete.
 */

import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';

const PORT = 8765;
const REDIRECT_URI = `http://127.0.0.1:${PORT}/callback`;
const SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';

const clientId = process.env.GMAIL_CLIENT_ID;
const clientSecret = process.env.GMAIL_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  console.error(
    'Set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET (from the OAuth client in the Google Cloud console) and re-run.',
  );
  process.exit(1);
}

const state = randomBytes(16).toString('hex');
const consentUrl = `https://accounts.google.com/o/oauth2/v2/auth?${new URLSearchParams(
  {
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    state,
  },
).toString()}`;

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', REDIRECT_URI);
  if (url.pathname !== '/callback') {
    res.writeHead(404).end();
    return;
  }
  const returnedState = url.searchParams.get('state');
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');
  if (error || !code || returnedState !== state) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end(`Consent failed: ${error ?? 'missing/invalid code or state'}`);
    console.error('Consent failed:', error ?? 'missing/invalid code or state');
    server.close();
    process.exitCode = 1;
    return;
  }

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: REDIRECT_URI,
    }).toString(),
  });
  const tokens = (await tokenRes.json()) as {
    refresh_token?: string;
    error_description?: string;
  };
  if (!tokenRes.ok || !tokens.refresh_token) {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Token exchange failed — see terminal.');
    console.error(
      'Token exchange failed:',
      tokens.error_description ?? `status ${tokenRes.status}`,
    );
    server.close();
    process.exitCode = 1;
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end(
    'Consent complete — you can close this tab. The refresh token is in the terminal.',
  );
  console.log('\nSUCCESS. Store this as the GMAIL_REFRESH_TOKEN secret:\n');
  console.log(tokens.refresh_token);
  console.log(
    '\n(Keep it out of git. It grants read-only Gmail access until revoked at https://myaccount.google.com/permissions.)',
  );
  server.close();
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('Open this URL in your browser and approve read-only access:\n');
  console.log(consentUrl);
  console.log(`\nWaiting for the redirect on ${REDIRECT_URI} …`);
});
