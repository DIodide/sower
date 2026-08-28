import { describe, expect, it } from 'vitest';
import { redactSecrets } from './redact.js';

/**
 * Every outbound runner string passes through redactSecrets; these pin
 * the exact shape that leaked in the wild — playwright's connectOverCDP
 * failure embedding the token-bearing browser_http URL — plus the
 * /t/<token>/ regex net for tokens missing from the secrets list.
 */

const TOKEN = 'ot-serve-token-9f3a';
const API_KEY = 'sower-api-key-77aa';

describe('redactSecrets', () => {
  it('masks every occurrence of every known secret', () => {
    const message = `auth ${TOKEN} rejected; retried with ${TOKEN} and key ${API_KEY}`;
    const out = redactSecrets(message, [TOKEN, API_KEY]);
    expect(out).toBe(
      'auth [redacted] rejected; retried with [redacted] and key [redacted]',
    );
  });

  it('scrubs a playwright connectOverCDP failure message', () => {
    const message = [
      'browserType.connectOverCDP: connect ECONNREFUSED 127.0.0.1:9333',
      'Call log:',
      `  - <ws preparing> retrieving websocket url from http://127.0.0.1:9333/t/${TOKEN}/i/i_default_headless/json/version`,
    ].join('\n');
    const out = redactSecrets(message, [TOKEN]);
    expect(out).not.toContain(TOKEN);
    expect(out).toContain(
      'http://127.0.0.1:9333/t/[redacted]/i/i_default_headless/json/version',
    );
  });

  it('masks /t/<token>/ path segments even for an unlisted token', () => {
    const out = redactSecrets(
      `GET http://127.0.0.1:9333/t/${TOKEN}/view/s/s_1 failed`,
      [],
    );
    expect(out).not.toContain(TOKEN);
    expect(out).toContain('/t/[redacted]/view/s/s_1');
  });

  it('ignores empty secrets and leaves clean text alone', () => {
    expect(
      redactSecrets('plain failure, no secrets here', ['', 'absent']),
    ).toBe('plain failure, no secrets here');
  });

  it('is idempotent', () => {
    const once = redactSecrets(`http://h/t/${TOKEN}/x`, [TOKEN]);
    expect(redactSecrets(once, [TOKEN])).toBe(once);
  });
});
