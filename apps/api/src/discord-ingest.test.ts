import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from './config.js';
import {
  ingestMessageLinks,
  reactionFor,
  replyFor,
  runDiscordIngestPoll,
} from './discord-ingest.js';
import type { Deps } from './types.js';

const platformState = vi.hoisted(() => ({
  byUrl: {} as Record<
    string,
    { platform: string; tenant: string | null; externalId: string | null }
  >,
  adapters: new Set<string>(),
}));
const ingestState = vi.hoisted(() => ({
  known: new Set<string>(),
  calls: [] as string[],
}));
const dirState = vi.hoisted(() => ({ byUrl: {} as Record<string, string[]> }));

vi.mock('@sower/platforms', () => ({
  detectPlatform: (url: string) =>
    platformState.byUrl[url] ?? {
      platform: 'unknown',
      tenant: null,
      externalId: null,
    },
  getAdapter: (platform: string) =>
    platformState.adapters.has(platform)
      ? { discover: async () => ({}) }
      : null,
  resolveUrl: async (url: string) => url,
}));

vi.mock('./ingest.js', () => ({
  ingestJob: vi.fn(async (_deps: unknown, input: { url: string }) => {
    ingestState.calls.push(input.url);
    return ingestState.known.has(input.url)
      ? { duplicate: true, jobId: 'dup' }
      : { duplicate: false, jobId: 'job-1', taskId: 'task-1', state: 'QUEUED' };
  }),
}));

// Keep the real extractUrlsFromText; only stub the network fetchJobLinks.
vi.mock('./link-extract.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./link-extract.js')>()),
  fetchJobLinks: vi.fn(async (url: string) => dirState.byUrl[url] ?? []),
}));

beforeEach(() => {
  platformState.byUrl = {};
  platformState.adapters = new Set(['greenhouse', 'ashby', 'lever', 'workday']);
  ingestState.known = new Set();
  ingestState.calls = [];
  dirState.byUrl = {};
});

describe('ingestMessageLinks', () => {
  it('ingests a supported direct link', async () => {
    platformState.byUrl['https://gh/1'] = {
      platform: 'greenhouse',
      tenant: 'acme',
      externalId: '1',
    };
    const s = await ingestMessageLinks({} as Deps, 'apply: https://gh/1');
    expect(s.ingested).toBe(1);
    expect(s.outcomes[0]).toMatchObject({
      kind: 'ingested',
      platform: 'greenhouse',
    });
    expect(ingestState.calls).toEqual(['https://gh/1']);
  });

  it('records an unsupported direct link (parked, never dropped)', async () => {
    platformState.byUrl['https://weirdats/x'] = {
      platform: 'unknown',
      tenant: null,
      externalId: null,
    };
    const s = await ingestMessageLinks({} as Deps, 'https://weirdats/x');
    expect(s.unsupported).toBe(1);
    expect(s.outcomes[0]).toMatchObject({ kind: 'unsupported' });
    // still routed through ingestJob (which records + parks the unknown job)
    expect(ingestState.calls).toEqual(['https://weirdats/x']);
  });

  it('expands a directory page into its supported job links', async () => {
    platformState.byUrl['https://dir/list'] = {
      platform: 'unknown',
      tenant: null,
      externalId: null,
    };
    platformState.byUrl['https://gh/2'] = {
      platform: 'greenhouse',
      tenant: 'a',
      externalId: '2',
    };
    platformState.byUrl['https://ashby/3'] = {
      platform: 'ashby',
      tenant: 'b',
      externalId: '3',
    };
    dirState.byUrl['https://dir/list'] = ['https://gh/2', 'https://ashby/3'];

    const s = await ingestMessageLinks({} as Deps, 'board: https://dir/list');
    expect(s.directories).toBe(1);
    expect(s.ingested).toBe(2);
    // the directory URL itself is NOT ingested; only its children are
    expect(ingestState.calls.sort()).toEqual([
      'https://ashby/3',
      'https://gh/2',
    ]);
    expect(s.outcomes[0]).toMatchObject({ kind: 'directory' });
  });

  it('records (not queues) a workday url without a /job/ path', async () => {
    const url = 'https://caci.wd1.myworkdayjobs.com/External/login';
    platformState.byUrl[url] = {
      platform: 'workday',
      tenant: 'caci',
      externalId: null,
    };
    const s = await ingestMessageLinks({} as Deps, `login page: ${url}`);
    expect(s.ingested).toBe(0);
    expect(s.unsupported).toBe(1);
    expect(s.outcomes[0]).toMatchObject({ kind: 'unsupported', url });
    // still recorded via ingestJob (parked), never dropped
    expect(ingestState.calls).toEqual([url]);
  });

  it('ingests a workday url with a /job/ path', async () => {
    const url = 'https://caci.wd1.myworkdayjobs.com/External/job/Jessup/SWE_1';
    platformState.byUrl[url] = {
      platform: 'workday',
      tenant: 'caci',
      externalId: null,
    };
    const s = await ingestMessageLinks({} as Deps, url);
    expect(s.ingested).toBe(1);
    expect(s.outcomes[0]).toMatchObject({
      kind: 'ingested',
      platform: 'workday',
      url,
    });
  });

  it('unwraps a redirect shim and ingests the embedded target', async () => {
    const target = 'https://boards.greenhouse.io/acme/jobs/77';
    platformState.byUrl[target] = {
      platform: 'greenhouse',
      tenant: 'acme',
      externalId: '77',
    };
    const shim = `https://l.instagram.com/?u=${encodeURIComponent(target)}`;
    const s = await ingestMessageLinks({} as Deps, `saw this: ${shim}`);
    expect(s.ingested).toBe(1);
    expect(s.outcomes[0]).toMatchObject({
      kind: 'ingested',
      platform: 'greenhouse',
      url: target,
    });
    expect(ingestState.calls).toEqual([target]);
  });

  it('counts a duplicate and handles a mixed message', async () => {
    platformState.byUrl['https://gh/1'] = {
      platform: 'greenhouse',
      tenant: 'a',
      externalId: '1',
    };
    platformState.byUrl['https://weird/x'] = {
      platform: 'unknown',
      tenant: null,
      externalId: null,
    };
    ingestState.known = new Set(['https://gh/1']); // already ingested
    const s = await ingestMessageLinks(
      {} as Deps,
      'https://gh/1 and https://weird/x',
    );
    expect(s).toMatchObject({ urls: 2, duplicates: 1, unsupported: 1 });
  });
});

describe('reactionFor / replyFor', () => {
  const base = {
    urls: 1,
    ingested: 0,
    duplicates: 0,
    unsupported: 0,
    directories: 0,
    errors: 0,
    outcomes: [],
  };
  it('picks the highest-signal emoji', () => {
    expect(reactionFor({ ...base, ingested: 1 })).toBe('✅');
    expect(reactionFor({ ...base, directories: 1 })).toBe('🔎');
    expect(reactionFor({ ...base, unsupported: 1 })).toBe('⚠️');
    expect(reactionFor({ ...base, duplicates: 1 })).toBe('♻️');
    expect(reactionFor({ ...base })).toBe('❌');
  });
  it('summarizes counts in the reply', () => {
    expect(replyFor({ ...base, ingested: 2, unsupported: 1 })).toContain(
      '✅ 2 queued',
    );
    expect(replyFor({ ...base })).toMatch(/No job links/);
  });
});

describe('runDiscordIngestPoll', () => {
  function fakeDeps(messages: unknown[]) {
    const reactions: { id: string; emoji: string }[] = [];
    const replies: string[] = [];
    const notify = {
      fetchChannelMessages: vi.fn(async () => messages),
      addReaction: vi.fn(async (_c: string, id: string, emoji: string) => {
        reactions.push({ id, emoji });
      }),
      postChannelMessage: vi.fn(async (_c: string, text: string) => {
        replies.push(text);
      }),
    };
    const deps = {
      config: {
        DISCORD_ENABLED: true,
        DISCORD_INGEST_CHANNEL_ID: 'chan-1',
      } as unknown as Config,
      notify,
    } as unknown as Deps;
    return { deps, notify, reactions, replies };
  }

  it('processes only fresh user messages with links; skips the rest', async () => {
    platformState.byUrl['https://gh/1'] = {
      platform: 'greenhouse',
      tenant: 'a',
      externalId: '1',
    };
    // newest-first as Discord returns them
    const messages = [
      { id: 'm-nolink', content: 'just chatting', author: { id: 'u' } },
      {
        id: 'm-done',
        content: 'https://gh/1',
        author: { id: 'u' },
        reactions: [{ me: true, emoji: { name: '✅' } }],
      },
      { id: 'm-bot', content: 'https://gh/1', author: { id: 'b', bot: true } },
      {
        id: 'm-fresh',
        content: 'please add https://gh/1',
        author: { id: 'u' },
      },
    ];
    const { deps, reactions, replies } = fakeDeps(messages);

    const result = await runDiscordIngestPoll(deps);

    expect(result).toMatchObject({ enabled: true, scanned: 4, processed: 1 });
    expect(reactions).toEqual([{ id: 'm-fresh', emoji: '✅' }]);
    expect(replies).toHaveLength(1);
    expect(ingestState.calls).toEqual(['https://gh/1']); // only the fresh one
  });

  it('is a no-op when Discord or the ingest channel is unconfigured', async () => {
    const deps = {
      config: { DISCORD_ENABLED: false } as unknown as Config,
      notify: { fetchChannelMessages: vi.fn() },
    } as unknown as Deps;
    const result = await runDiscordIngestPoll(deps);
    expect(result).toEqual({ enabled: false, scanned: 0, processed: 0 });
  });
});
