import { promises as fs } from 'node:fs';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { compileTex } from './tectonic.js';

/**
 * Compile-preview HTTP server: the SAME container image as the Cloud Run
 * Job, started in server mode when infra sets RESUME_COMPILE_SERVER=1 (only
 * the compile-preview Cloud Run SERVICE gets that env — see main.ts). POST
 * /compile takes raw LaTeX source and answers with the compiled PDF, giving
 * the dashboard editor a fast preview with no Job execution, no clone, and
 * no DB row.
 *
 * No in-app auth: the service is IAM-gated (no public invoker), so only
 * identities granted run.invoker — the api's service account — ever reach
 * this process; the api front-door is where the user-facing auth lives.
 *
 * node:http only — the job image gains no dependencies for this role.
 */

/** Raw request cap; the JSON wrapper around a max-size source stays under it. */
const MAX_BODY_BYTES = 250 * 1024;
/** Mirrors the api's edit/compile-preview source cap. */
const MAX_SOURCE_CHARS = 200_000;
/** Tail cap on the log returned for a failed compile. */
const MAX_LOG_CHARS = 20_000;
/**
 * Per-request cap (queue wait + compile). Sits under compileTex's 120s exec
 * timeout, which remains the backstop that actually kills a runaway
 * tectonic — this cap only stops the CLIENT waiting on one.
 */
const COMPILE_TIMEOUT_MS = 90_000;

type CompileFn = typeof compileTex;

export interface HandlerOptions {
  /** Injected by tests; the real tectonic pipeline otherwise. */
  compile?: CompileFn;
  timeoutMs?: number;
}

interface CompileVerdict {
  ok: boolean;
  pdf?: string;
  log?: string;
}

/**
 * The compile temp dir's filename stem. Whatever the caller sent collapses
 * to [a-z0-9-_] — path bits and dots included, so the name can never escape
 * the temp dir — with 'resume' as the fallback for anything that collapses
 * to nothing. The length cap keeps `<name>.sower-build.tex` comfortably
 * under filesystem name limits.
 */
export function sanitizeName(name: unknown): string {
  if (typeof name !== 'string') {
    return 'resume';
  }
  const cleaned = name
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, '')
    .slice(0, 64);
  return cleaned === '' ? 'resume' : cleaned;
}

/**
 * Buffer the request body up to MAX_BODY_BYTES. Past the cap the remainder
 * is read and DISCARDED (never stored) instead of destroying the socket, so
 * the 400 always reaches the client.
 */
function readBody(req: IncomingMessage): Promise<Buffer | 'too-large'> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let overCap = false;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        overCap = true;
        chunks.length = 0;
      } else {
        chunks.push(chunk);
      }
    });
    req.on('end', () => {
      resolve(overCap ? 'too-large' : Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}

/**
 * One compile in a fresh temp dir: write `<name>.tex`, hand it to the
 * compile fn (compileTex — which owns the pdfTeX-directive preprocessing and
 * leaves `<name>.pdf` behind), read the PDF back. A compile-fn throw is the
 * EXPECTED failure shape, not a 5xx: its message carries only the command
 * line + tectonic output (exec caps and redacts it at the source), so the
 * tail is safe to hand to the client verbatim — process env is never in it.
 */
async function runCompile(
  compile: CompileFn,
  source: string,
  name: string,
): Promise<CompileVerdict> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sower-compile-'));
  try {
    await fs.writeFile(path.join(dir, `${name}.tex`), source, 'utf8');
    try {
      await compile(dir, `${name}.tex`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return { ok: false, log: detail.slice(-MAX_LOG_CHARS) };
    }
    const pdf = await fs.readFile(path.join(dir, `${name}.pdf`));
    return { ok: true, pdf: pdf.toString('base64') };
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export function createRequestHandler(
  options: HandlerOptions = {},
): (req: IncomingMessage, res: ServerResponse) => void {
  const compile = options.compile ?? compileTex;
  const timeoutMs = options.timeoutMs ?? COMPILE_TIMEOUT_MS;

  // Promise-chain mutex: tectonic is CPU-bound, so compiles run one at a
  // time. Cloud Run's request-concurrency cap does this too — belt and
  // suspenders. A rejection must not sever the chain, hence the second arm.
  let chain: Promise<unknown> = Promise.resolve();
  const locked = <T>(task: () => Promise<T>): Promise<T> => {
    const next = chain.then(task, task);
    chain = next.catch(() => {});
    return next;
  };

  const handle = async (
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> => {
    const url = (req.url ?? '').split('?')[0] ?? '';
    if (req.method === 'GET' && url === '/healthz') {
      sendJson(res, 200, { ok: true });
      return;
    }
    if (req.method !== 'POST' || url !== '/compile') {
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    const raw = await readBody(req);
    if (raw === 'too-large') {
      sendJson(res, 400, { ok: false, log: 'source too large' });
      return;
    }
    let body: unknown;
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      sendJson(res, 400, { ok: false, log: 'body must be JSON' });
      return;
    }
    const source =
      body !== null && typeof body === 'object'
        ? (body as { source?: unknown }).source
        : undefined;
    if (typeof source !== 'string' || source.length === 0) {
      sendJson(res, 400, { ok: false, log: 'source (string) is required' });
      return;
    }
    if (source.length > MAX_SOURCE_CHARS) {
      sendJson(res, 400, { ok: false, log: 'source too large' });
      return;
    }
    const name = sanitizeName((body as { name?: unknown }).name);

    const work = locked(() => runCompile(compile, source, name));
    let timer: NodeJS.Timeout | undefined;
    try {
      const verdict = await Promise.race([
        work,
        new Promise<'timeout'>((resolve) => {
          timer = setTimeout(() => resolve('timeout'), timeoutMs);
        }),
      ]);
      if (verdict === 'timeout') {
        // The abandoned compile still runs to completion inside the chain
        // (exec's own timeout reaps a truly hung tectonic) and cleans its
        // temp dir up there; only THIS response stops waiting.
        work.catch(() => {});
        sendJson(res, 200, { ok: false, log: 'compile timed out' });
        return;
      }
      sendJson(res, 200, verdict);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  };

  return (req, res) => {
    handle(req, res).catch((error) => {
      // Unexpected (non-compile) failure: the response body stays generic —
      // internal detail belongs in the service logs only.
      console.error('resume-compile-server: request failed:', error);
      if (!res.headersSent) {
        sendJson(res, 500, { ok: false, log: 'internal error' });
      } else {
        res.end();
      }
    });
  };
}

export function startServer(): Server {
  const port = Number(process.env.PORT ?? 8080);
  const server = createServer(createRequestHandler());
  server.listen(port, () => {
    console.log(`resume-compile-server: listening on :${port}`);
  });
  return server;
}
