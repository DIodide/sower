/**
 * Token scrubbing for everything the resume-editor job records or logs.
 *
 * The GitHub token rides in git's insteadOf config
 * (`url."https://x-access-token:<token>@github.com/".insteadOf ...`), so a
 * failed git command can echo it back through error messages, stderr, or the
 * rendered command line. Every string that can land in the resume_runs row
 * (error column, transcript) or in Cloud Run logs MUST pass through
 * redactSecrets first — see exec.ts, which applies it to every thrown
 * subprocess error.
 */

const REDACTED = '[redacted]';

/**
 * Credential-in-URL form: `https://x-access-token:<token>@github.com/...`
 * (or any `user:pass@` / `user@` userinfo in an http(s) URL). Scrubbed even
 * when the literal secret is unknown, so a clone URL leaking through a path
 * we didn't anticipate still comes out clean.
 */
const URL_CREDENTIAL_RE = /(https?:\/\/)([^/@\s]+)@/gi;

/**
 * Remove every occurrence of the given secrets (and any URL userinfo) from
 * `text`. Empty/undefined secrets are ignored so a missing env var can never
 * turn the redactor into a no-op-with-a-crash.
 */
export function redactSecrets(
  text: string,
  secrets: readonly (string | undefined)[],
): string {
  let out = text;
  for (const secret of secrets) {
    if (secret !== undefined && secret.length > 0) {
      out = out.split(secret).join(REDACTED);
    }
  }
  return out.replace(URL_CREDENTIAL_RE, `$1${REDACTED}@`);
}
