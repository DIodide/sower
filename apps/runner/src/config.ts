import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Credential resolution. Sower mirrors apps/cli/src/config.ts: env
 * SOWER_API_KEY / SOWER_API_BASE, then ~/.config/sower/config.json
 * ({token, base}), then the api's default local port; the token has no
 * default and is never echoed. OpenTab: OPENTAB_BASE / OPENTAB_TOKEN env,
 * else the serve token OpenTab writes to `${OPENTAB_HOME ?? ~/.opentab}/token`
 * (opentab src/auth.ts).
 */

export const DEFAULT_SOWER_BASE = 'http://127.0.0.1:8080';
export const DEFAULT_OPENTAB_BASE = 'http://127.0.0.1:9333';

export interface ServiceConfig {
  token: string | null;
  /** Base URL, trailing slashes stripped so `${base}${path}` composes. */
  base: string;
}

export function sowerConfigPath(): string {
  return join(homedir(), '.config', 'sower', 'config.json');
}

export function opentabTokenPath(
  env: Record<string, string | undefined>,
): string {
  return join(env.OPENTAB_HOME ?? join(homedir(), '.opentab'), 'token');
}

/** First value that is set and non-blank — '' in env means unset. */
function firstNonEmpty(...values: (string | undefined)[]): string | undefined {
  for (const value of values) {
    if (value !== undefined && value.trim() !== '') {
      return value;
    }
  }
  return undefined;
}

export function resolveSowerConfig(
  env: Record<string, string | undefined>,
  readFile: (path: string) => string,
): ServiceConfig {
  let fileToken: string | undefined;
  let fileBase: string | undefined;
  try {
    const parsed: unknown = JSON.parse(readFile(sowerConfigPath()));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      if (typeof record.token === 'string') {
        fileToken = record.token;
      }
      if (typeof record.base === 'string') {
        fileBase = record.base;
      }
    }
  } catch {
    // No config file (or unreadable/invalid JSON): env may still configure.
  }
  const token = firstNonEmpty(env.SOWER_API_KEY, fileToken);
  const base =
    firstNonEmpty(env.SOWER_API_BASE, fileBase) ?? DEFAULT_SOWER_BASE;
  return { token: token ?? null, base: base.replace(/\/+$/, '') };
}

export function resolveOpenTabConfig(
  env: Record<string, string | undefined>,
  readFile: (path: string) => string,
): ServiceConfig {
  let fileToken: string | undefined;
  try {
    fileToken = readFile(opentabTokenPath(env)).trim() || undefined;
  } catch {
    // No serve-token file yet: env may still configure.
  }
  const token = firstNonEmpty(env.OPENTAB_TOKEN, fileToken);
  const base = firstNonEmpty(env.OPENTAB_BASE) ?? DEFAULT_OPENTAB_BASE;
  return { token: token ?? null, base: base.replace(/\/+$/, '') };
}
