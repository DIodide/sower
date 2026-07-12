/**
 * Discord configuration for Sower notifications.
 *
 * The app id, public key, guild id, and channel map are NOT secrets and are
 * committed here as defaults. The bot token IS a secret: it is only ever read
 * from the DISCORD_BOT_TOKEN environment variable (populated from Secret
 * Manager in production) and must never be committed or logged.
 *
 * Precedence: environment variables (DISCORD_CHANNEL_MAP, DISCORD_PUBLIC_KEY,
 * DISCORD_BOT_TOKEN, DISCORD_APP_ID) override the committed defaults.
 */

export const DISCORD_API_BASE = 'https://discord.com/api/v10';

export const DEFAULT_DISCORD_APP_ID = '1525747560684322956';

export const DEFAULT_DISCORD_PUBLIC_KEY =
  'c461bfe425fa9fb69b7ae93f440e957ab93b472be6525502a7374b0f01813f5c';

export const DEFAULT_DISCORD_GUILD_ID = '1525747896132309104';

export const DEFAULT_DISCORD_CHANNEL_MAP: Readonly<Record<string, string>> = {
  greenhouse: '1525749024261541978',
  ashby: '1525749024827641877',
  lever: '1525749025897316503',
  workday: '1525749026451095595',
};

type Env = Record<string, string | undefined>;

/**
 * Parse the platform -> channel id map from the DISCORD_CHANNEL_MAP env var
 * (a JSON object of string to string), falling back to the committed default.
 * Throws on malformed configuration so bad deploys fail loudly.
 */
export function createChannelMapFromEnv(
  env: Env = process.env,
): Record<string, string> {
  const raw = env.DISCORD_CHANNEL_MAP;
  if (raw === undefined || raw.trim() === '') {
    return { ...DEFAULT_DISCORD_CHANNEL_MAP };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `DISCORD_CHANNEL_MAP is not valid JSON: ${(error as Error).message}`,
    );
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('DISCORD_CHANNEL_MAP must be a JSON object');
  }
  const map: Record<string, string> = {};
  for (const [platform, channelId] of Object.entries(parsed)) {
    if (typeof channelId !== 'string' || channelId === '') {
      throw new Error(
        `DISCORD_CHANNEL_MAP["${platform}"] must be a non-empty string channel id`,
      );
    }
    map[platform] = channelId;
  }
  return map;
}

/** Ed25519 public key (hex) used to verify interaction signatures. */
export function getDiscordPublicKey(env: Env = process.env): string {
  return env.DISCORD_PUBLIC_KEY || DEFAULT_DISCORD_PUBLIC_KEY;
}

/** Discord application id (non-secret). */
export function getDiscordAppId(env: Env = process.env): string {
  return env.DISCORD_APP_ID || DEFAULT_DISCORD_APP_ID;
}

/**
 * Bot token, from the environment only. Returns undefined when Discord is
 * disabled (no token configured). There is deliberately no committed default.
 */
export function getDiscordBotToken(env: Env = process.env): string | undefined {
  return env.DISCORD_BOT_TOKEN || undefined;
}

/**
 * Resolve the channel for a platform: channel map entry first, then the
 * DISCORD_FALLBACK_CHANNEL env var, else undefined.
 */
export function resolveChannelId(
  platform: string,
  env: Env = process.env,
): string | undefined {
  const map = createChannelMapFromEnv(env);
  return map[platform] ?? env.DISCORD_FALLBACK_CHANNEL ?? undefined;
}

/**
 * Strip the bot token from a string so it can never leak into logs or
 * error messages.
 */
export function redactToken(text: string, env: Env = process.env): string {
  const token = getDiscordBotToken(env);
  if (!token) return text;
  return text.split(token).join('[redacted]');
}
