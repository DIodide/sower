import { lookup } from 'node:dns/promises';

/**
 * SSRF guards for the form-discovery browser. The URL being rendered is
 * USER-SUPPLIED and the job runs on GCP, whose metadata endpoint
 * (169.254.169.254) is the classic SSRF target.
 *
 * Two layers:
 *   1. `assertSafeFetchTarget` — a synchronous literal check on the entry
 *      URL (mirrors apps/api/src/link-extract.ts; kept local because
 *      packages must not depend on apps).
 *   2. `isSafeRequestTarget` — the async check the Playwright route
 *      interceptor runs on EVERY request the browser makes (navigation,
 *      redirects, subresources): forbidden-host literals first, then a DNS
 *      lookup so a public hostname that resolves to a private/loopback/
 *      link-local address (DNS rebinding) is aborted too. Fails closed.
 */

/** True for private/loopback/link-local/CGNAT IPv4+IPv6 literals. */
export function isPrivateIp(ip: string): boolean {
  let candidate = ip.toLowerCase();
  // IPv4-mapped IPv6 (::ffff:10.0.0.1) — check the embedded IPv4.
  const mapped = candidate.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped?.[1]) candidate = mapped[1];
  const v4 = candidate.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true; // link-local incl. metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
    return false;
  }
  if (candidate === '::1' || candidate === '::') return true;
  // IPv6 ULA (fc00::/7) + link-local (fe80::/10) literals
  return (
    candidate.startsWith('fc') ||
    candidate.startsWith('fd') ||
    candidate.startsWith('fe80')
  );
}

/** localhost / *.local / *.internal / private-IP literal (no DNS needed). */
export function isForbiddenHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    isPrivateIp(host)
  );
}

/** SSRF guard: http(s) only; reject localhost / internal / private-IP hosts. */
export function assertSafeFetchTarget(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`invalid url: ${url}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`refusing non-http(s) url: ${parsed.protocol}`);
  }
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (isForbiddenHost(host)) {
    throw new Error(`refusing internal/private host: ${host}`);
  }
}

/**
 * Async request-level check for the Playwright route interceptor: literal
 * checks first, then DNS-resolve the host and require EVERY resolved
 * address to be public. DNS failures fail closed. `cache` memoizes the
 * per-host verdict so a page with hundreds of subresources resolves each
 * host once.
 */
export async function isSafeRequestTarget(
  url: string,
  cache: Map<string, boolean>,
): Promise<boolean> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return false;
  }
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (isForbiddenHost(host)) return false;
  const cached = cache.get(host);
  if (cached !== undefined) return cached;
  let safe = false;
  try {
    const addresses = await lookup(host, { all: true, verbatim: true });
    safe =
      addresses.length > 0 &&
      addresses.every((entry) => !isPrivateIp(entry.address));
  } catch {
    safe = false; // NXDOMAIN / resolver error — fail closed
  }
  cache.set(host, safe);
  return safe;
}
