import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Where the CLI's token and base URL come from. Precedence: env
 * SOWER_API_KEY / SOWER_API_BASE, then ~/.config/sower/config.json
 * ({token, base} — written by `sower auth set`, chmod 600), then
 * DEFAULT_BASE for the base. The token has NO default: commands report
 * `not configured` (exit 3) without one. The token is NEVER echoed —
 * not in output, not in errors, not in this module's return values
 * beyond the resolved config the request layer consumes.
 */

/** The api's default local port (apps/api config PORT). */
export const DEFAULT_BASE = 'http://127.0.0.1:8080';

export function configPath(): string {
  return join(homedir(), '.config', 'sower', 'config.json');
}

export interface ResolvedConfig {
  token: string | null;
  /** Base URL, trailing slashes stripped so `${base}${path}` composes. */
  base: string;
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

export function resolveConfig(
  env: Record<string, string | undefined>,
  readFile: (path: string) => string,
): ResolvedConfig {
  let fileToken: string | undefined;
  let fileBase: string | undefined;
  try {
    const parsed: unknown = JSON.parse(readFile(configPath()));
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
  const base = firstNonEmpty(env.SOWER_API_BASE, fileBase) ?? DEFAULT_BASE;
  return { token: token ?? null, base: base.replace(/\/+$/, '') };
}

/** Filesystem surface writeAuthConfig needs — injected so tests stay dry. */
export interface AuthConfigFs {
  /** mkdir -p, mode 0700 — the config dir holds a secret. */
  mkdir(path: string): void;
  /** Throws when the file does not exist. */
  readFile(path: string): string;
  writeFile(path: string, content: string): void;
  chmod(path: string, mode: number): void;
}

/**
 * Persist `sower auth set`: merge onto any existing config (setting only a
 * token keeps a previously saved base) and keep the file chmod 600 — it
 * holds the api token.
 */
export function writeAuthConfig(
  update: { token: string; base?: string },
  io: AuthConfigFs,
): string {
  const path = configPath();
  io.mkdir(dirname(path));
  let existing: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(io.readFile(path));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      existing = parsed as Record<string, unknown>;
    }
  } catch {
    // First write (or an unreadable file we simply replace).
  }
  const next = {
    ...existing,
    token: update.token,
    ...(update.base !== undefined ? { base: update.base } : {}),
  };
  io.writeFile(path, `${JSON.stringify(next, null, 2)}\n`);
  io.chmod(path, 0o600);
  return path;
}
