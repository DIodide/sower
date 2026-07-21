import { promises as fs } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequestHandler, sanitizeName } from './server.js';

// Everything runs against a real node:http server on an ephemeral port with
// an INJECTED compile fn — the raw-body cap and JSON handling are exercised
// end-to-end, and no test ever needs a tectonic binary.

type Handler = ReturnType<typeof createRequestHandler>;

interface CompileCall {
  cwd: string;
  texFile: string;
  source: string;
}

const servers: (() => Promise<void>)[] = [];

afterEach(async () => {
  while (servers.length > 0) {
    await servers.pop()?.();
  }
});

async function listen(handler: Handler): Promise<string> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  servers.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeIdleConnections();
        server.close(() => resolve());
      }),
  );
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

function post(payload: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof payload === 'string' ? payload : JSON.stringify(payload),
  };
}

/** tectonic stand-in: records the call and leaves `<name>.pdf` behind. */
function fakeCompile(calls: CompileCall[]) {
  return async (cwd: string, texFile: string): Promise<void> => {
    const source = await fs.readFile(path.join(cwd, texFile), 'utf8');
    calls.push({ cwd, texFile, source });
    await fs.writeFile(
      path.join(cwd, texFile.replace(/\.tex$/, '.pdf')),
      'pdf-bytes',
    );
  };
}

describe('sanitizeName', () => {
  it.each([
    ['swe-2027', 'swe-2027'],
    ['My_Resume', 'my_resume'],
    ['../Evil Name!.tex', 'evilnametex'],
    ['', 'resume'],
    ['///...', 'resume'],
  ])('sanitizes %j to %j', (input, expected) => {
    expect(sanitizeName(input)).toBe(expected);
  });

  it('falls back to resume for non-strings and caps the length', () => {
    expect(sanitizeName(undefined)).toBe('resume');
    expect(sanitizeName(42)).toBe('resume');
    expect(sanitizeName('a'.repeat(200))).toBe('a'.repeat(64));
  });
});

describe('compile server', () => {
  it('GET /healthz answers ok', async () => {
    const url = await listen(
      createRequestHandler({ compile: fakeCompile([]) }),
    );
    const response = await fetch(`${url}/healthz`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it('404s any other route', async () => {
    const url = await listen(
      createRequestHandler({ compile: fakeCompile([]) }),
    );
    const response = await fetch(`${url}/nope`);
    expect(response.status).toBe(404);
  });

  it('POST /compile returns the PDF base64-encoded and removes the temp dir', async () => {
    const calls: CompileCall[] = [];
    const url = await listen(
      createRequestHandler({ compile: fakeCompile(calls) }),
    );
    const source = '\\documentclass{article}\\begin{document}hi\\end{document}';
    const response = await fetch(
      `${url}/compile`,
      post({ source, name: 'Swe-2027' }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; pdf?: string };
    expect(body.ok).toBe(true);
    expect(Buffer.from(body.pdf ?? '', 'base64').toString('utf8')).toBe(
      'pdf-bytes',
    );
    const call = calls[0];
    expect(call?.texFile).toBe('swe-2027.tex');
    expect(call?.source).toBe(source);
    // A fresh mkdtemp dir under the OS tmpdir, gone once the compile is done.
    expect(call?.cwd.startsWith(os.tmpdir())).toBe(true);
    await expect(fs.access(call?.cwd ?? '')).rejects.toThrow();
  });

  it('compiles as resume.tex when no name is sent', async () => {
    const calls: CompileCall[] = [];
    const url = await listen(
      createRequestHandler({ compile: fakeCompile(calls) }),
    );
    const response = await fetch(`${url}/compile`, post({ source: '\\x' }));
    expect(response.status).toBe(200);
    expect(calls[0]?.texFile).toBe('resume.tex');
  });

  it('400s a source over the char cap without compiling', async () => {
    const calls: CompileCall[] = [];
    const url = await listen(
      createRequestHandler({ compile: fakeCompile(calls) }),
    );
    const response = await fetch(
      `${url}/compile`,
      post({ source: 'x'.repeat(200_001) }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      ok: false,
      log: 'source too large',
    });
    expect(calls).toEqual([]);
  });

  it('400s a raw body over 250KB without buffering it', async () => {
    const calls: CompileCall[] = [];
    const url = await listen(
      createRequestHandler({ compile: fakeCompile(calls) }),
    );
    const response = await fetch(
      `${url}/compile`,
      post({ source: 'x', pad: 'y'.repeat(300_000) }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      ok: false,
      log: 'source too large',
    });
    expect(calls).toEqual([]);
  });

  it('400s malformed JSON', async () => {
    const url = await listen(
      createRequestHandler({ compile: fakeCompile([]) }),
    );
    const response = await fetch(`${url}/compile`, post('{not json'));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      ok: false,
      log: 'body must be JSON',
    });
  });

  it.each([
    [{}],
    [{ source: '' }],
    [{ source: 42 }],
    [[1, 2]],
  ])('400s a body without a usable source: %j', async (payload) => {
    const url = await listen(
      createRequestHandler({ compile: fakeCompile([]) }),
    );
    const response = await fetch(`${url}/compile`, post(payload));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      ok: false,
      log: 'source (string) is required',
    });
  });

  it('answers 200 ok:false with the log TAIL when the compile fails, and still cleans up', async () => {
    const dirs: string[] = [];
    const compile = async (cwd: string): Promise<void> => {
      dirs.push(cwd);
      throw new Error(`compiling x failed: ${'y'.repeat(25_000)}TAIL-MARKER`);
    };
    const url = await listen(createRequestHandler({ compile }));
    const response = await fetch(`${url}/compile`, post({ source: '\\bad' }));
    // A failed compile is an expected outcome — never a 5xx.
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; log?: string };
    expect(body.ok).toBe(false);
    expect(body.log).toHaveLength(20_000);
    expect(body.log?.endsWith('TAIL-MARKER')).toBe(true);
    await expect(fs.access(dirs[0] ?? '')).rejects.toThrow();
  });

  it('serializes concurrent compiles through the mutex', async () => {
    const started: string[] = [];
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const compile = async (cwd: string, texFile: string): Promise<void> => {
      started.push(texFile);
      if (started.length === 1) {
        await gate;
      }
      await fs.writeFile(
        path.join(cwd, texFile.replace(/\.tex$/, '.pdf')),
        'pdf-bytes',
      );
    };
    const url = await listen(createRequestHandler({ compile }));
    const first = fetch(`${url}/compile`, post({ source: 'a', name: 'first' }));
    await vi.waitFor(() => {
      expect(started).toEqual(['first.tex']);
    });
    const second = fetch(
      `${url}/compile`,
      post({ source: 'b', name: 'second' }),
    );
    // The second compile must not start while the first holds the lock.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(started).toEqual(['first.tex']);
    release();
    const [one, two] = await Promise.all([first, second]);
    expect(((await one.json()) as { ok: boolean }).ok).toBe(true);
    expect(((await two.json()) as { ok: boolean }).ok).toBe(true);
    expect(started).toEqual(['first.tex', 'second.tex']);
  });

  it('caps a hung compile at the request timeout', async () => {
    const url = await listen(
      createRequestHandler({
        compile: () => new Promise<void>(() => {}),
        timeoutMs: 30,
      }),
    );
    const response = await fetch(`${url}/compile`, post({ source: '\\x' }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: false,
      log: 'compile timed out',
    });
  });
});
