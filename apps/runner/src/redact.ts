/**
 * Secret scrubbing for every string the runner emits (fill-job fail
 * errors, report details, console lines). Playwright's connectOverCDP
 * failure messages embed the full token-bearing OpenTab URL, so both the
 * known secrets AND any OpenTab /t/<token>/ path segment are masked
 * before a message leaves the process.
 */

const OPENTAB_TOKEN_SEGMENT = /\/t\/[^/\s"']+/g;

export function redactSecrets(
  message: string,
  secrets: readonly string[],
): string {
  let out = message;
  for (const secret of secrets) {
    if (secret !== '') {
      out = out.split(secret).join('[redacted]');
    }
  }
  return out.replace(OPENTAB_TOKEN_SEGMENT, '/t/[redacted]');
}
