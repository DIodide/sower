import { describe, expect, it } from 'vitest';
import {
  createChannelMapFromEnv,
  DEFAULT_DISCORD_APP_ID,
  DEFAULT_DISCORD_CHANNEL_MAP,
  DEFAULT_DISCORD_PUBLIC_KEY,
  getDiscordAppId,
  getDiscordBotToken,
  getDiscordPublicKey,
  redactToken,
  resolveChannelId,
} from './config.js';

describe('createChannelMapFromEnv', () => {
  it('returns the committed defaults when the env var is unset', () => {
    const map = createChannelMapFromEnv({});
    expect(map).toEqual(DEFAULT_DISCORD_CHANNEL_MAP);
    expect(map.greenhouse).toBe('1525749024261541978');
    expect(map.ashby).toBe('1525749024827641877');
    expect(map.lever).toBe('1525749025897316503');
    expect(map.workday).toBe('1525749026451095595');
  });

  it('returns a copy, not the shared default object', () => {
    const map = createChannelMapFromEnv({});
    map.greenhouse = 'mutated';
    expect(createChannelMapFromEnv({}).greenhouse).toBe('1525749024261541978');
  });

  it('parses DISCORD_CHANNEL_MAP from the env, overriding defaults', () => {
    const map = createChannelMapFromEnv({
      DISCORD_CHANNEL_MAP: '{"greenhouse":"111","custom":"222"}',
    });
    expect(map).toEqual({ greenhouse: '111', custom: '222' });
  });

  it('throws on invalid JSON', () => {
    expect(() =>
      createChannelMapFromEnv({ DISCORD_CHANNEL_MAP: '{nope' }),
    ).toThrow(/not valid JSON/);
  });

  it('throws on non-object or non-string values', () => {
    expect(() =>
      createChannelMapFromEnv({ DISCORD_CHANNEL_MAP: '["a"]' }),
    ).toThrow(/JSON object/);
    expect(() =>
      createChannelMapFromEnv({ DISCORD_CHANNEL_MAP: '{"greenhouse":42}' }),
    ).toThrow(/non-empty string/);
  });
});

describe('config precedence', () => {
  it('env values override committed defaults', () => {
    expect(getDiscordPublicKey({ DISCORD_PUBLIC_KEY: 'aa'.repeat(32) })).toBe(
      'aa'.repeat(32),
    );
    expect(getDiscordPublicKey({})).toBe(DEFAULT_DISCORD_PUBLIC_KEY);
    expect(getDiscordAppId({ DISCORD_APP_ID: '999' })).toBe('999');
    expect(getDiscordAppId({})).toBe(DEFAULT_DISCORD_APP_ID);
  });

  it('bot token has no default and comes only from the env', () => {
    expect(getDiscordBotToken({})).toBeUndefined();
    expect(getDiscordBotToken({ DISCORD_BOT_TOKEN: '' })).toBeUndefined();
    expect(getDiscordBotToken({ DISCORD_BOT_TOKEN: 'tok' })).toBe('tok');
  });
});

describe('resolveChannelId', () => {
  it('maps platform to channel, then falls back to DISCORD_FALLBACK_CHANNEL', () => {
    expect(resolveChannelId('greenhouse', {})).toBe('1525749024261541978');
    expect(
      resolveChannelId('unknown-platform', {
        DISCORD_FALLBACK_CHANNEL: '777',
      }),
    ).toBe('777');
    expect(resolveChannelId('unknown-platform', {})).toBeUndefined();
  });
});

describe('redactToken', () => {
  it('strips the token from text and is a no-op without a token', () => {
    const env = { DISCORD_BOT_TOKEN: 'sekret-token-value' };
    expect(redactToken('error: Bot sekret-token-value rejected', env)).toBe(
      'error: Bot [redacted] rejected',
    );
    expect(redactToken('nothing here', env)).toBe('nothing here');
    expect(redactToken('sekret-token-value', {})).toBe('sekret-token-value');
  });
});
