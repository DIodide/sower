import { describe, expect, it } from 'vitest';
import { redactSecrets } from './redact.js';

describe('redactSecrets', () => {
  it('removes every occurrence of a known secret', () => {
    const out = redactSecrets('token ghp_abc123 again ghp_abc123', [
      'ghp_abc123',
    ]);
    expect(out).toBe('token [redacted] again [redacted]');
    expect(out).not.toContain('ghp_abc123');
  });

  it('scrubs a tokenized clone URL even when the secret is not listed', () => {
    const out = redactSecrets(
      "fatal: unable to access 'https://x-access-token:ghp_secreT99@github.com/DIodide/portfolio.git/'",
      [],
    );
    expect(out).toContain(
      'https://[redacted]@github.com/DIodide/portfolio.git',
    );
    expect(out).not.toContain('ghp_secreT99');
    expect(out).not.toContain('x-access-token:');
  });

  it('scrubs the insteadOf config form (token inside a git config value)', () => {
    const token = 'github_pat_XYZ';
    const out = redactSecrets(
      `git config --global url.https://x-access-token:${token}@github.com/.insteadOf https://github.com/ failed`,
      [token],
    );
    expect(out).not.toContain(token);
  });

  it('handles multiple URLs in one message', () => {
    const out = redactSecrets(
      'push https://a:b@github.com/x.git then https://c:d@github.com/y.git',
      [],
    );
    expect(out).toBe(
      'push https://[redacted]@github.com/x.git then https://[redacted]@github.com/y.git',
    );
  });

  it('leaves credential-free URLs and text alone', () => {
    const text = 'cloned https://github.com/DIodide/portfolio.git ok';
    expect(redactSecrets(text, ['tok'])).toBe(text);
  });

  it('ignores undefined/empty secrets', () => {
    expect(redactSecrets('abc', [undefined, ''])).toBe('abc');
  });
});
