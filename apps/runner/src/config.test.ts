import { describe, expect, it } from 'vitest';
import {
  DEFAULT_OPENTAB_BASE,
  DEFAULT_SOWER_BASE,
  opentabTokenPath,
  resolveOpenTabConfig,
  resolveSowerConfig,
  sowerConfigPath,
} from './config.js';

/**
 * Both credential resolutions (env → file → defaults) against injected
 * file readers — no real filesystem, no HOME mutation.
 */

const noFile = () => {
  throw new Error('ENOENT');
};

describe('resolveSowerConfig', () => {
  it('prefers env over the config file', () => {
    const config = resolveSowerConfig(
      { SOWER_API_KEY: 'env-token', SOWER_API_BASE: 'https://env.example' },
      () =>
        JSON.stringify({ token: 'file-token', base: 'https://file.example' }),
    );
    expect(config).toEqual({ token: 'env-token', base: 'https://env.example' });
  });

  it('falls back to ~/.config/sower/config.json when env is unset', () => {
    const config = resolveSowerConfig({}, (path) => {
      expect(path).toBe(sowerConfigPath());
      return JSON.stringify({
        token: 'file-token',
        base: 'https://file.example',
      });
    });
    expect(config).toEqual({
      token: 'file-token',
      base: 'https://file.example',
    });
  });

  it('reports no token (and the default base) when nothing is configured', () => {
    expect(resolveSowerConfig({}, noFile)).toEqual({
      token: null,
      base: DEFAULT_SOWER_BASE,
    });
  });

  it('strips trailing slashes from the base', () => {
    const config = resolveSowerConfig(
      { SOWER_API_KEY: 't', SOWER_API_BASE: 'https://env.example//' },
      noFile,
    );
    expect(config.base).toBe('https://env.example');
  });
});

describe('resolveOpenTabConfig', () => {
  it('prefers OPENTAB_TOKEN over the serve-token file', () => {
    const config = resolveOpenTabConfig(
      { OPENTAB_TOKEN: 'env-token' },
      () => 'file-token\n',
    );
    expect(config).toEqual({
      token: 'env-token',
      base: DEFAULT_OPENTAB_BASE,
    });
  });

  it('reads and trims the serve-token file', () => {
    const env = {};
    const config = resolveOpenTabConfig(env, (path) => {
      expect(path).toBe(opentabTokenPath(env));
      return 'abcdef0123456789\n';
    });
    expect(config.token).toBe('abcdef0123456789');
  });

  it('honors OPENTAB_HOME for the token path', () => {
    expect(opentabTokenPath({ OPENTAB_HOME: '/srv/opentab' })).toBe(
      '/srv/opentab/token',
    );
  });

  it('takes the base from OPENTAB_BASE', () => {
    const config = resolveOpenTabConfig(
      { OPENTAB_BASE: 'http://mini.local:9333/' },
      noFile,
    );
    expect(config.base).toBe('http://mini.local:9333');
  });

  it('reports a missing token when nothing is configured', () => {
    expect(resolveOpenTabConfig({}, noFile)).toEqual({
      token: null,
      base: DEFAULT_OPENTAB_BASE,
    });
  });
});
