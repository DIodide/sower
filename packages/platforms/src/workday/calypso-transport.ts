import { spawn } from 'node:child_process';

/**
 * A Chrome-TLS-impersonating, proxy-capable transport for the calypso client.
 *
 * WHY: replaying the calypso API over Node's stock TLS from a datacenter IP is
 * blocked before the cookies are even read — Cloudflare/reCAPTCHA score the
 * JA3/JA4 fingerprint and the ASN first (see workday-browser-tier.md). This
 * transport shells out to `curl-impersonate`, which reproduces a real Chrome
 * TLS + HTTP-2 fingerprint, and routes through the SAME residential proxy the
 * session was captured behind. The home-IP MVP does not need this (plain fetch
 * works there); it's the robustness path for hard tenants and Cloud Run.
 *
 * Requires the `curl-impersonate` binary on the host (e.g.
 * `curl-impersonate-chrome`); when absent, createCurlImpersonateFetch rejects
 * with a clear install hint rather than silently degrading.
 */

export interface ImpersonateOptions {
  /** curl-impersonate target, e.g. 'chrome131' (default). */
  impersonate?: string;
  /** Residential proxy URL, e.g. 'http://user:pass@host:port'. */
  proxyUrl?: string;
  /** Path/name of the curl-impersonate binary. */
  binaryPath?: string;
  /** Per-request timeout (seconds) passed to curl. */
  maxTimeSeconds?: number;
}

const DEFAULT_IMPERSONATE = 'chrome131';
const DEFAULT_BINARY = 'curl-impersonate-chrome';

/** Chrome majors curl-impersonate ships presets for (ascending). */
const SUPPORTED_CHROME_TARGETS = [
  99, 100, 101, 104, 107, 110, 116, 119, 120, 123, 124, 131, 133,
] as const;

/** Extract the Chrome major version from a User-Agent, or undefined. */
export function chromeMajorFromUserAgent(
  userAgent: string | undefined,
): number | undefined {
  const match = userAgent?.match(/Chrome\/(\d+)\./);
  return match?.[1] ? Number.parseInt(match[1], 10) : undefined;
}

/**
 * Pick the curl-impersonate target for a captured Chrome major: the newest
 * supported preset that is <= the captured version (so the impersonated
 * fingerprint never claims to be newer than the browser we captured), falling
 * back to the newest preset when the version is unknown or older than all.
 */
export function chromeImpersonateTarget(chromeMajor?: number): string {
  if (chromeMajor === undefined) {
    return DEFAULT_IMPERSONATE;
  }
  let best: number = SUPPORTED_CHROME_TARGETS[0];
  for (const target of SUPPORTED_CHROME_TARGETS) {
    if (target <= chromeMajor) {
      best = target;
    }
  }
  return `chrome${best}`;
}
/** Marker separating the body from the trailing status curl -w appends. */
const STATUS_MARKER = '\n__SOWER_HTTP_STATUS__';

/** Normalize HeadersInit (the shapes CalypsoClient passes) to entries. */
function headerEntries(headers: HeadersInit | undefined): [string, string][] {
  if (!headers) return [];
  if (Array.isArray(headers)) return headers as [string, string][];
  if (headers instanceof Headers) return [...headers.entries()];
  return Object.entries(headers as Record<string, string>);
}

/**
 * Build the curl-impersonate argv for one request. PURE — no I/O — so the
 * exact flags (impersonate target, proxy, method, headers, body) are testable.
 * `-w` appends the status after a marker so the wrapper can split body/status
 * without capturing response headers (which we don't need for calypso).
 */
export function buildCurlImpersonateArgs(
  url: string,
  init: { method?: string; headers?: HeadersInit; body?: string } = {},
  opts: ImpersonateOptions = {},
): string[] {
  const method = (init.method ?? 'GET').toUpperCase();
  const args = [
    '--impersonate',
    opts.impersonate ?? DEFAULT_IMPERSONATE,
    '-s', // silent (no progress)
    '-S', // but still show errors
    '--compressed',
    '--max-time',
    String(opts.maxTimeSeconds ?? 30),
  ];
  if (opts.proxyUrl) {
    args.push('--proxy', opts.proxyUrl);
  }
  args.push('-X', method);
  for (const [name, value] of headerEntries(init.headers)) {
    args.push('-H', `${name}: ${value}`);
  }
  if (init.body !== undefined && init.body !== null) {
    args.push('--data-raw', init.body);
  }
  args.push('-w', `${STATUS_MARKER}%{http_code}`);
  args.push(url);
  return args;
}

/** Split curl-impersonate stdout into { body, status } (pure). */
export function parseCurlOutput(stdout: string): {
  body: string;
  status: number;
} {
  const idx = stdout.lastIndexOf(STATUS_MARKER);
  if (idx === -1) {
    return { body: stdout, status: 0 };
  }
  const body = stdout.slice(0, idx);
  const status = Number.parseInt(stdout.slice(idx + STATUS_MARKER.length), 10);
  return { body, status: Number.isNaN(status) ? 0 : status };
}

/**
 * A `fetch`-compatible function that runs each request through
 * curl-impersonate (Chrome TLS + optional residential proxy) and returns a
 * standard Response. Drop it into `new CalypsoClient(session, { fetchImpl })`.
 */
export function createCurlImpersonateFetch(
  opts: ImpersonateOptions = {},
  spawnImpl: typeof spawn = spawn,
): typeof fetch {
  const binary = opts.binaryPath ?? DEFAULT_BINARY;
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const args = buildCurlImpersonateArgs(
      url,
      {
        method: init?.method,
        headers: init?.headers,
        body: typeof init?.body === 'string' ? init.body : undefined,
      },
      opts,
    );
    const { body, status } = await new Promise<{
      body: string;
      status: number;
    }>((resolve, reject) => {
      const child = spawnImpl(binary, args);
      let out = '';
      let err = '';
      child.stdout?.on('data', (d) => {
        out += d;
      });
      child.stderr?.on('data', (d) => {
        err += d;
      });
      child.on('error', (e: NodeJS.ErrnoException) => {
        reject(
          e.code === 'ENOENT'
            ? new Error(
                `${binary} not found — install curl-impersonate (e.g. brew install curl-impersonate) or set binaryPath`,
              )
            : e,
        );
      });
      child.on('close', (code) => {
        if (code !== 0 && !out) {
          reject(new Error(`${binary} exited ${code}: ${err.slice(0, 200)}`));
          return;
        }
        resolve(parseCurlOutput(out));
      });
    });
    return new Response(body, { status: status || 502 });
  }) as typeof fetch;
}
