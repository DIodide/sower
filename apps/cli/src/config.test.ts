import { describe, expect, it } from 'vitest';
import {
  type AuthConfigFs,
  configPath,
  DEFAULT_BASE,
  resolveConfig,
  writeAuthConfig,
} from './config.js';

/**
 * Config precedence (env → file → defaults) and the auth-set write path,
 * both against injected file readers — no real filesystem, no HOME
 * mutation.
 */

const noFile = () => {
  throw new Error('ENOENT');
};

describe('resolveConfig', () => {
  it('prefers env over the config file', () => {
    const config = resolveConfig(
      { SOWER_API_KEY: 'env-token', SOWER_API_BASE: 'https://env.example' },
      () =>
        JSON.stringify({ token: 'file-token', base: 'https://file.example' }),
    );
    expect(config).toEqual({ token: 'env-token', base: 'https://env.example' });
  });

  it('falls back to the config file when env is unset', () => {
    const config = resolveConfig({}, () =>
      JSON.stringify({ token: 'file-token', base: 'https://file.example' }),
    );
    expect(config).toEqual({
      token: 'file-token',
      base: 'https://file.example',
    });
  });

  it('treats blank env values as unset', () => {
    const config = resolveConfig(
      { SOWER_API_KEY: '', SOWER_API_BASE: '  ' },
      () =>
        JSON.stringify({ token: 'file-token', base: 'https://file.example' }),
    );
    expect(config).toEqual({
      token: 'file-token',
      base: 'https://file.example',
    });
  });

  it('reports no token (and the default base) when nothing is configured', () => {
    expect(resolveConfig({}, noFile)).toEqual({
      token: null,
      base: DEFAULT_BASE,
    });
  });

  it('survives an invalid config file', () => {
    expect(resolveConfig({}, () => 'not json')).toEqual({
      token: null,
      base: DEFAULT_BASE,
    });
  });

  it('strips trailing slashes from the base', () => {
    const config = resolveConfig(
      { SOWER_API_KEY: 't', SOWER_API_BASE: 'https://api.example/' },
      noFile,
    );
    expect(config.base).toBe('https://api.example');
  });
});

describe('writeAuthConfig', () => {
  function fakeFs(existing?: string) {
    const calls = {
      mkdir: [] as string[],
      writes: [] as { path: string; content: string }[],
      chmods: [] as { path: string; mode: number }[],
    };
    const io: AuthConfigFs = {
      mkdir: (path) => calls.mkdir.push(path),
      readFile: () => {
        if (existing === undefined) {
          throw new Error('ENOENT');
        }
        return existing;
      },
      writeFile: (path, content) => calls.writes.push({ path, content }),
      chmod: (path, mode) => calls.chmods.push({ path, mode }),
    };
    return { io, calls };
  }

  it('creates the dir, writes the config, and chmods it to 600', () => {
    const { io, calls } = fakeFs();
    const path = writeAuthConfig({ token: 'tok', base: 'https://x' }, io);
    expect(path).toBe(configPath());
    expect(calls.mkdir).toHaveLength(1);
    expect(path.startsWith(`${calls.mkdir[0]}/`)).toBe(true);
    expect(calls.writes).toHaveLength(1);
    expect(JSON.parse(calls.writes[0]?.content ?? '')).toEqual({
      token: 'tok',
      base: 'https://x',
    });
    expect(calls.chmods).toEqual([{ path, mode: 0o600 }]);
  });

  it('keeps a previously saved base when only the token is set', () => {
    const { io, calls } = fakeFs(
      JSON.stringify({ token: 'old', base: 'https://kept.example' }),
    );
    writeAuthConfig({ token: 'new' }, io);
    expect(JSON.parse(calls.writes[0]?.content ?? '')).toEqual({
      token: 'new',
      base: 'https://kept.example',
    });
  });
});
