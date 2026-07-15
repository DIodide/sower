import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from './config.js';
import type { MessageIngestSummary, UrlOutcome } from './discord-ingest.js';
import {
  ingestMessageLinks,
  reactionFor,
  replyFor,
  runDiscordIngestPoll,
} from './discord-ingest.js';
import type { Deps } from './types.js';

const CDN_URL = 'https://cdn.discordapp.com/attachments/1/2/shot.png';

const IMAGE_ATTACHMENT = {
  id: 'att-1',
  filename: 'shot.png',
  content_type: 'image/png',
  url: CDN_URL,
  size: 3,
};

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
  duplicateMeta: {
    taskId: 'task-dup' as string | null,
    originalSource: 'discord',
    originalCreatedAt: new Date('2026-07-13T19:47:00Z'),
  },
}));
const dirState = vi.hoisted(() => ({ byUrl: {} as Record<string, string[]> }));
const triggerState = vi.hoisted(() => ({ calls: [] as string[] }));

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
      ? { duplicate: true, jobId: 'dup', ...ingestState.duplicateMeta }
      : { duplicate: false, jobId: 'job-1', taskId: 'task-1', state: 'QUEUED' };
  }),
}));

// Tier-2 form-discovery trigger: recorded so tests can assert exactly which
// parked tasks fire an investigator Job (the real one self-gates + never throws).
vi.mock('./investigate-trigger.js', () => ({
  triggerInvestigation: vi.fn(async (_deps: unknown, taskId: string) => {
    triggerState.calls.push(taskId);
  }),
}));

// Keep the real extractUrlsFromText; only stub the network fetchJobLinks.
vi.mock('./link-extract.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./link-extract.js')>()),
  fetchJobLinks: vi.fn(async (url: string) => dirState.byUrl[url] ?? []),
}));

// Screenshot ingest vaults image bytes; never touch the real vault in tests.
vi.mock('@sower/storage', () => ({
  createStorage: () => ({ put: vi.fn(async () => {}) }),
}));

beforeEach(() => {
  platformState.byUrl = {};
  platformState.adapters = new Set(['greenhouse', 'ashby', 'lever', 'workday']);
  ingestState.known = new Set();
  ingestState.calls = [];
  ingestState.duplicateMeta = {
    taskId: 'task-dup',
    originalSource: 'discord',
    originalCreatedAt: new Date('2026-07-13T19:47:00Z'),
  };
  dirState.byUrl = {};
  triggerState.calls = [];
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

  it('records an unsupported direct link (parked, never dropped) and triggers form discovery', async () => {
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
    // a directly-sent (depth-0) unsupported link fires the investigator Job
    expect(triggerState.calls).toEqual(['task-1']);
  });

  it('does NOT trigger form discovery for a supported link or a duplicate', async () => {
    platformState.byUrl['https://gh/1'] = {
      platform: 'greenhouse',
      tenant: 'a',
      externalId: '1',
    };
    platformState.byUrl['https://weirdats/dup'] = {
      platform: 'unknown',
      tenant: null,
      externalId: null,
    };
    ingestState.known = new Set(['https://weirdats/dup']); // already parked
    const s = await ingestMessageLinks(
      {} as Deps,
      'https://gh/1 https://weirdats/dup',
    );
    expect(s).toMatchObject({ ingested: 1, duplicates: 1 });
    // Neither the queued job nor the already-known unsupported one re-fires.
    expect(triggerState.calls).toEqual([]);
  });

  it("does NOT trigger form discovery for a directory's unsupported children", async () => {
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
    // https://weird/child stays unknown (the byUrl fallback) and has no links
    // of its own, so at depth 1 it is recorded+parked — but never triggered.
    dirState.byUrl['https://dir/list'] = [
      'https://gh/2',
      'https://weird/child',
    ];

    const s = await ingestMessageLinks({} as Deps, 'board: https://dir/list');
    expect(s.directories).toBe(1);
    expect(s.ingested).toBe(1);
    expect(s.unsupported).toBe(1);
    // A 50-link directory must not spawn 50 browser Jobs: no trigger at depth 1.
    expect(triggerState.calls).toEqual([]);
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
    // The duplicate outcome carries the original's task, source, and time.
    expect(s.outcomes[0]).toMatchObject({
      kind: 'duplicate',
      taskId: 'task-dup',
      originalSource: 'discord',
      originalCreatedAt: new Date('2026-07-13T19:47:00Z'),
    });
    // Fresh outcomes carry the created task so the reply can link it.
    expect(s.outcomes[1]).toMatchObject({
      kind: 'unsupported',
      taskId: 'task-1',
    });
  });
});

describe('reactionFor / replyFor', () => {
  const base: MessageIngestSummary = {
    urls: 1,
    ingested: 0,
    duplicates: 0,
    unsupported: 0,
    directories: 0,
    errors: 0,
    screenshots: 0,
    outcomes: [],
    screenshotOutcomes: [],
  };
  const BASE_URL = 'https://sower-dashboard-abc.run.app';

  it('picks the highest-signal emoji', () => {
    expect(reactionFor({ ...base, ingested: 1 })).toBe('✅');
    expect(reactionFor({ ...base, directories: 1 })).toBe('🔎');
    expect(reactionFor({ ...base, unsupported: 1 })).toBe('⚠️');
    expect(reactionFor({ ...base, duplicates: 1 })).toBe('♻️');
    expect(reactionFor({ ...base })).toBe('❌');
  });

  it('marks a screenshot-only message handled (never ❌)', () => {
    expect(reactionFor({ ...base, screenshots: 1 })).toBe('🖼️');
    // A queued link still outranks the screenshot marker.
    expect(reactionFor({ ...base, screenshots: 1, ingested: 1 })).toBe('✅');
  });

  it('links ingested, unsupported, and screenshot outcomes to their tasks', () => {
    const reply = replyFor(
      {
        ...base,
        urls: 2,
        ingested: 1,
        unsupported: 1,
        screenshots: 1,
        outcomes: [
          {
            url: 'https://gh/1',
            kind: 'ingested',
            platform: 'greenhouse',
            jobId: 'job-1',
            taskId: 'task-1111-aaaa',
          },
          {
            url: 'https://weird/x',
            kind: 'unsupported',
            jobId: 'job-2',
            taskId: 'task-2222-bbbb',
          },
        ],
        screenshotOutcomes: [
          {
            kind: 'screenshot',
            jobId: 'job-3',
            taskId: 'task-3333-cccc',
            filename: 'shot.png',
            stored: true,
          },
        ],
      },
      BASE_URL,
    );
    expect(reply).toContain(
      `✅ [\`task-111\`](${BASE_URL}/tasks/task-1111-aaaa) queued · greenhouse`,
    );
    expect(reply).toContain(
      `⚠️ recorded (unsupported) → [\`task-222\`](${BASE_URL}/tasks/task-2222-bbbb)`,
    );
    expect(reply).toContain(
      `🖼️ screenshot recorded → [\`task-333\`](${BASE_URL}/tasks/task-3333-cccc)`,
    );
  });

  it('links a duplicate to the existing task with original time + repo source', () => {
    const reply = replyFor(
      {
        ...base,
        duplicates: 1,
        outcomes: [
          {
            url: 'https://gh/1',
            kind: 'duplicate',
            jobId: 'job-1',
            taskId: 'task-orig-1',
            originalSource: 'SimplifyJobs/Summer2027-Internships',
            // 19:47 UTC = 3:47 PM in America/New_York (EDT).
            originalCreatedAt: new Date('2026-07-13T19:47:00Z'),
          },
        ],
      },
      BASE_URL,
    );
    expect(reply).toContain(
      `♻️ duplicate of [\`task-ori\`](${BASE_URL}/tasks/task-orig-1)`,
    );
    expect(reply).toContain('originally added Jul 13, 3:47 PM ET');
    expect(reply).toContain(
      '[SimplifyJobs/Summer2027-Internships](https://github.com/SimplifyJobs/Summer2027-Internships)',
    );
  });

  it('renders a non-repo duplicate source (discord) as plain text', () => {
    const reply = replyFor(
      {
        ...base,
        duplicates: 1,
        outcomes: [
          {
            url: 'https://gh/1',
            kind: 'duplicate',
            jobId: 'job-1',
            taskId: 'task-orig-1',
            originalSource: 'discord',
            originalCreatedAt: new Date('2026-07-13T19:47:00Z'),
          },
        ],
      },
      BASE_URL,
    );
    expect(reply).toContain('via discord');
    expect(reply).not.toContain('github.com/discord');
  });

  it('degrades to backticked task ids when no dashboard base URL is set', () => {
    const reply = replyFor({
      ...base,
      urls: 2,
      ingested: 1,
      duplicates: 1,
      screenshots: 1,
      outcomes: [
        {
          url: 'https://gh/1',
          kind: 'ingested',
          platform: 'greenhouse',
          jobId: 'job-1',
          taskId: 'task-1111-aaaa',
        },
        {
          url: 'https://gh/2',
          kind: 'duplicate',
          jobId: 'job-2',
          taskId: 'task-orig-1',
          originalSource: 'discord',
          originalCreatedAt: new Date('2026-07-13T19:47:00Z'),
        },
      ],
      screenshotOutcomes: [
        {
          kind: 'screenshot',
          jobId: 'job-3',
          taskId: 'task-3333-cccc',
          filename: 'shot.png',
          stored: true,
        },
      ],
    });
    expect(reply).toContain('✅ `task-111` queued · greenhouse');
    expect(reply).toContain('♻️ duplicate of `task-ori`');
    expect(reply).toContain('🖼️ screenshot recorded → `task-333`');
    expect(reply).toContain('originally added Jul 13, 3:47 PM ET via discord');
    expect(reply).not.toContain('](');
  });

  it('summarizes a directory outcome with child counts', () => {
    const reply = replyFor(
      {
        ...base,
        directories: 1,
        ingested: 2,
        unsupported: 1,
        outcomes: [
          {
            url: 'https://dir/list',
            kind: 'directory',
            children: [
              {
                url: 'https://gh/1',
                kind: 'ingested',
                platform: 'greenhouse',
                jobId: 'j1',
                taskId: 't1',
              },
              {
                url: 'https://gh/2',
                kind: 'ingested',
                platform: 'ashby',
                jobId: 'j2',
                taskId: 't2',
              },
              {
                url: 'https://weird/x',
                kind: 'unsupported',
                jobId: 'j3',
                taskId: 't3',
              },
            ],
          },
        ],
      },
      BASE_URL,
    );
    expect(reply).toContain(
      '🔎 3 links from a directory (2 queued, 1 recorded)',
    );
  });

  it('itemizes an error with a shortened url', () => {
    const reply = replyFor(
      {
        ...base,
        errors: 1,
        outcomes: [
          {
            url: 'https://broken.example/jobs/1',
            kind: 'error',
            error: 'boom',
          },
        ],
      },
      BASE_URL,
    );
    expect(reply).toContain('❌ broken.example/jobs/1: boom');
  });

  it('caps a long reply under 2000 chars with a "…+N more" summary', () => {
    const outcomes: UrlOutcome[] = Array.from({ length: 40 }, (_, i) => ({
      url: `https://gh/${i}`,
      kind: 'ingested' as const,
      platform: 'greenhouse',
      jobId: `job-${i}`,
      taskId: `task-${String(i).padStart(4, '0')}-abcdef-ghijkl`,
    }));
    const reply = replyFor(
      { ...base, urls: 40, ingested: 40, outcomes },
      BASE_URL,
    );
    expect(reply.length).toBeLessThanOrEqual(2000);
    expect(reply).toContain('…+30 more');
    // 10 itemized lines + the summary line.
    expect(reply.split('\n')).toHaveLength(11);
  });

  it('keeps the empty-message reply', () => {
    expect(replyFor({ ...base }, BASE_URL)).toMatch(/No job links/);
    expect(replyFor({ ...base })).toMatch(/No job links/);
  });
});

describe('runDiscordIngestPoll', () => {
  function fakeDeps(messages: unknown[]) {
    const reactions: { id: string; emoji: string }[] = [];
    const replies: string[] = [];
    const inserted: Record<string, unknown>[] = [];
    const notify = {
      fetchChannelMessages: vi.fn(async () => messages),
      addReaction: vi.fn(async (_c: string, id: string, emoji: string) => {
        reactions.push({ id, emoji });
      }),
      postChannelMessage: vi.fn(async (_c: string, text: string) => {
        replies.push(text);
      }),
    };
    // Minimal db: captures the documents rows screenshot ingest inserts.
    const db = {
      insert: () => ({
        values: async (row: Record<string, unknown>) => {
          inserted.push(row);
          return [];
        },
      }),
    };
    const deps = {
      config: {
        DISCORD_ENABLED: true,
        DISCORD_INGEST_CHANNEL_ID: 'chan-1',
        DISCORD_APP_ID: 'app-self',
        DASHBOARD_BASE_URL: 'https://dash.test',
      } as unknown as Config,
      notify,
      db,
    } as unknown as Deps;
    return { deps, notify, reactions, replies, inserted };
  }

  it('processes fresh messages with links from any author; skips reacted + no-link', async () => {
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
      // A link forwarded by another bot/webhook must still ingest (no author skip).
      { id: 'm-bot', content: 'https://gh/1', author: { id: 'b', bot: true } },
      {
        id: 'm-fresh',
        content: 'please add https://gh/1',
        author: { id: 'u' },
      },
    ];
    const { deps, reactions, replies } = fakeDeps(messages);

    const result = await runDiscordIngestPoll(deps);

    // oldest-first: m-fresh (ingest) → m-bot (ingest) → m-done (reacted, skip)
    // → m-nolink (no url, skip).
    expect(result).toMatchObject({ enabled: true, scanned: 4, processed: 2 });
    expect(reactions).toEqual([
      { id: 'm-fresh', emoji: '✅' },
      { id: 'm-bot', emoji: '✅' },
    ]);
    expect(replies).toHaveLength(2);
    expect(ingestState.calls).toEqual(['https://gh/1', 'https://gh/1']);
  });

  it('skips the bot own reply, and never ingests a dashboard/IAP link (no self-loop)', async () => {
    platformState.byUrl['https://gh/2'] = {
      platform: 'greenhouse',
      tenant: 'a',
      externalId: '2',
    };
    const messages = [
      // The bot's own reply (author.id === app id) — must be skipped entirely,
      // even though it embeds a dashboard task link.
      {
        id: 'm-self',
        content: '✅ [`abc`](https://dash.test/tasks/abc) queued',
        author: { id: 'app-self', bot: true },
      },
      // A human message that (oddly) contains a dashboard link + a real job link:
      // the dashboard link is dropped, the job link still ingests.
      {
        id: 'm-mixed',
        content: 'see https://dash.test/tasks/xyz and https://gh/2',
        author: { id: 'u' },
      },
    ];
    const { deps, reactions } = fakeDeps(messages);

    const result = await runDiscordIngestPoll(deps);

    // m-self skipped (self-authored); m-mixed processed but only the job link.
    expect(result).toMatchObject({ processed: 1 });
    expect(reactions).toEqual([{ id: 'm-mixed', emoji: '✅' }]);
    expect(ingestState.calls).toEqual(['https://gh/2']); // dashboard link dropped
  });

  it('processes an image-only message: parked + stored, 🖼️ reaction', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(Buffer.from([1, 2, 3]), {
        status: 200,
        headers: { 'content-type': 'image/png' },
      }),
    );
    try {
      const messages = [
        {
          id: 'm-shot',
          content: 'saw this on a flyer',
          author: { id: 'u' },
          attachments: [IMAGE_ATTACHMENT],
        },
      ];
      const { deps, reactions, replies, inserted } = fakeDeps(messages);

      const result = await runDiscordIngestPoll(deps);

      // NOT skipped despite having no URL in its content.
      expect(result).toMatchObject({ enabled: true, scanned: 1, processed: 1 });
      expect(reactions).toEqual([{ id: 'm-shot', emoji: '🖼️' }]);
      expect(replies).toHaveLength(1);
      // The reply links the parked task on the dashboard.
      expect(replies[0]).toContain(
        '🖼️ screenshot recorded → [`task-1`](https://dash.test/tasks/task-1)',
      );
      // Parked via ingestJob and linked to the job via a documents row.
      expect(ingestState.calls).toEqual([CDN_URL]);
      expect(inserted).toHaveLength(1);
      expect(inserted[0]).toMatchObject({
        kind: 'screenshot',
        filename: 'shot.png',
        jobId: 'job-1',
      });
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('handles a mixed message: link ingested AND screenshot recorded', async () => {
    platformState.byUrl['https://gh/1'] = {
      platform: 'greenhouse',
      tenant: 'a',
      externalId: '1',
    };
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(Buffer.from([1, 2, 3]), {
        status: 200,
        headers: { 'content-type': 'image/png' },
      }),
    );
    try {
      const messages = [
        {
          id: 'm-mixed',
          content: 'apply https://gh/1',
          author: { id: 'u' },
          attachments: [IMAGE_ATTACHMENT],
        },
      ];
      const { deps, reactions, replies, inserted } = fakeDeps(messages);

      const result = await runDiscordIngestPoll(deps);

      expect(result).toMatchObject({ enabled: true, scanned: 1, processed: 1 });
      // The queued link wins the reaction; the reply itemizes both outcomes,
      // each linked to its dashboard task.
      expect(reactions).toEqual([{ id: 'm-mixed', emoji: '✅' }]);
      expect(replies[0]).toContain(
        '✅ [`task-1`](https://dash.test/tasks/task-1) queued · greenhouse',
      );
      expect(replies[0]).toContain(
        '🖼️ screenshot recorded → [`task-1`](https://dash.test/tasks/task-1)',
      );
      // Both the text link and the attachment went through ingestJob.
      expect(ingestState.calls).toEqual(['https://gh/1', CDN_URL]);
      expect(inserted).toHaveLength(1);
    } finally {
      fetchSpy.mockRestore();
    }
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
