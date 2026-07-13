import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
  buildCurlImpersonateArgs,
  chromeImpersonateTarget,
  chromeMajorFromUserAgent,
  createCurlImpersonateFetch,
  parseCurlOutput,
} from './calypso-transport.js';

describe('chromeMajorFromUserAgent', () => {
  it('extracts the Chrome major version', () => {
    expect(
      chromeMajorFromUserAgent(
        'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      ),
    ).toBe(131);
  });
  it('returns undefined for a non-Chrome / missing UA', () => {
    expect(chromeMajorFromUserAgent(undefined)).toBeUndefined();
    expect(chromeMajorFromUserAgent('Firefox/128.0')).toBeUndefined();
  });
});

describe('chromeImpersonateTarget', () => {
  it('picks the newest supported preset <= the captured major', () => {
    expect(chromeImpersonateTarget(131)).toBe('chrome131');
    expect(chromeImpersonateTarget(132)).toBe('chrome131'); // never claim newer than a preset
    expect(chromeImpersonateTarget(121)).toBe('chrome120');
    expect(chromeImpersonateTarget(140)).toBe('chrome133');
  });
  it('falls back to the default when unknown or ancient', () => {
    expect(chromeImpersonateTarget(undefined)).toBe('chrome131');
    expect(chromeImpersonateTarget(50)).toBe('chrome99');
  });
});

describe('buildCurlImpersonateArgs', () => {
  it('defaults to chrome131, GET, and appends the status writeout + url last', () => {
    const args = buildCurlImpersonateArgs('https://x/y');
    expect(args.slice(0, 2)).toEqual(['--impersonate', 'chrome131']);
    expect(args).toContain('-X');
    expect(args[args.indexOf('-X') + 1]).toBe('GET');
    // url is the final arg; the -w writeout precedes it.
    expect(args.at(-1)).toBe('https://x/y');
    expect(args.at(-3)).toBe('-w');
  });

  it('adds --proxy only when a proxyUrl is given', () => {
    expect(buildCurlImpersonateArgs('https://x')).not.toContain('--proxy');
    const withProxy = buildCurlImpersonateArgs(
      'https://x',
      {},
      {
        proxyUrl: 'http://u:p@host:1',
      },
    );
    expect(withProxy[withProxy.indexOf('--proxy') + 1]).toBe(
      'http://u:p@host:1',
    );
  });

  it('serializes headers as -H and a string body as --data-raw', () => {
    const args = buildCurlImpersonateArgs('https://x', {
      method: 'POST',
      headers: { cookie: 'A=1', 'x-calypso-csrf-token': 'tok' },
      body: '{"a":1}',
    });
    expect(args).toContain('cookie: A=1');
    expect(args).toContain('x-calypso-csrf-token: tok');
    expect(args[args.indexOf('--data-raw') + 1]).toBe('{"a":1}');
    expect(args[args.indexOf('-X') + 1]).toBe('POST');
  });

  it('accepts a custom impersonate target', () => {
    const args = buildCurlImpersonateArgs(
      'https://x',
      {},
      {
        impersonate: 'chrome124',
      },
    );
    expect(args[1]).toBe('chrome124');
  });
});

describe('parseCurlOutput', () => {
  it('splits the body from the trailing status marker', () => {
    const out = `{"total":0}\n__SOWER_HTTP_STATUS__200`;
    expect(parseCurlOutput(out)).toEqual({ body: '{"total":0}', status: 200 });
  });

  it('handles a missing marker (status 0)', () => {
    expect(parseCurlOutput('raw body')).toEqual({
      body: 'raw body',
      status: 0,
    });
  });

  it('reads a non-200 status', () => {
    expect(parseCurlOutput(`err\n__SOWER_HTTP_STATUS__500`).status).toBe(500);
  });
});

/** A fake ChildProcess that emits scripted stdout then closes. */
function fakeChild(stdout: string, code = 0, errorCode?: string) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  setTimeout(() => {
    if (errorCode) {
      child.emit(
        'error',
        Object.assign(new Error('boom'), { code: errorCode }),
      );
      return;
    }
    child.stdout.emit('data', stdout);
    child.emit('close', code);
  }, 0);
  return child;
}

describe('createCurlImpersonateFetch', () => {
  it('spawns the binary and returns a Response with the parsed status/body', async () => {
    const spawnMock = vi.fn((_bin: string, _args: string[]) =>
      fakeChild(`{"ok":true}\n__SOWER_HTTP_STATUS__200`),
    );
    const fetchImpl = createCurlImpersonateFetch(
      { proxyUrl: 'http://p' },
      spawnMock as never,
    );

    const res = await fetchImpl('https://x/applications', { method: 'GET' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    // The spawn used curl-impersonate with the proxy.
    const [, args] = spawnMock.mock.calls[0] as [string, string[]];
    expect(args).toContain('--proxy');
  });

  it('rejects with an install hint when the binary is missing', async () => {
    const spawnMock = vi.fn((_bin: string, _args: string[]) =>
      fakeChild('', 1, 'ENOENT'),
    );
    const fetchImpl = createCurlImpersonateFetch({}, spawnMock as never);
    await expect(fetchImpl('https://x')).rejects.toThrow(
      /install curl-impersonate/,
    );
  });
});
