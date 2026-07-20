import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from './config.js';
import { buildServer } from './server.js';
import type { Deps } from './types.js';

// POST /ingest/paste drives the SAME ingress-agnostic classifier the Discord
// #ingest poll uses (ingestMessageLinks). The classifier's routing logic is
// proven in discord-ingest.test.ts; these tests mock its collaborators the
// same way and assert the endpoint's contract: auth, body validation,
// source:'manual' threading, the summary counts, and the flattened outcomes.

const platformState = vi.hoisted(() => ({
  byUrl: {} as Record<
    string,
    { platform: string; tenant: string | null; externalId: string | null }
  >,
  adapters: new Set<string>(),
}));
const ingestState = vi.hoisted(() => ({
  known: new Set<string>(),
  /** URLs that make the mocked ingestJob throw (error-outcome fixtures). */
  failUrls: new Set<string>(),
  calls: [] as { url: string; source?: string }[],
  duplicateTaskId: 'task-dup' as string | null,
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
  // Verified tenant probe (proven in @sower/platforms + discord-ingest tests):
  // no fixture here ever carries a tenant-less greenhouse ref, so always null.
  deriveGreenhouseTenant: async () => null,
}));

vi.mock('./ingest.js', () => ({
  ingestJob: vi.fn(
    async (_deps: unknown, input: { url: string; source?: string }) => {
      ingestState.calls.push({ url: input.url, source: input.source });
      if (ingestState.failUrls.has(input.url)) {
        throw new Error('boom: upstream 500');
      }
      return ingestState.known.has(input.url)
        ? {
            duplicate: true,
            jobId: 'dup',
            taskId: ingestState.duplicateTaskId,
            originalSource: 'discord',
            originalCreatedAt: new Date('2026-07-13T19:47:00Z'),
          }
        : {
            duplicate: false,
            jobId: 'job-1',
            taskId: 'task-1',
            state: 'QUEUED',
          };
    },
  ),
}));

vi.mock('./investigate-trigger.js', () => ({
  triggerInvestigation: vi.fn(async (_deps: unknown, taskId: string) => {
    triggerState.calls.push(taskId);
    return false;
  }),
}));

// Keep the real pure helpers (extractUrlsFromText, unwrapRedirectShim, …);
// only the network fetch and the directory link extractor are stubbed.
vi.mock('./link-extract.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./link-extract.js')>()),
  fetchPageHtml: vi.fn(async (url: string) =>
    dirState.byUrl[url] ? { html: '', url } : null,
  ),
  extractJobLinks: vi.fn(
    (_html: string, url: string) => dirState.byUrl[url] ?? [],
  ),
}));

vi.mock('./ingest-reply.js', () => ({
  refreshIngestReply: vi.fn(async () => {}),
}));

const config: Config = {
  PORT: 8080,
  DATABASE_URL: 'postgres://postgres:sower@localhost:5432/sower',
  INGEST_API_KEY: 'test-key',
  QUEUE_DRIVER: 'inline',
  GCP_PROJECT_ID: undefined,
  GCP_REGION: undefined,
  TASKS_QUEUE: 'apply-queue',
  TASKS_TARGET_BASE_URL: undefined,
  PROFILE_PATH: './config/profile.sample.yaml',
  ANSWER_BANK_PATH: './config/answer-bank.sample.yaml',
  SIMPLIFY_TERMS: 'Summer 2027',
  SIMPLIFY_MAX_PER_RUN: 10,
  SOURCE_INVESTIGATE_PER_RUN: 5,
  SOWER_SUBMIT_ENABLED: 'false',
  SOWER_ENV: 'test',
  DISCORD_BOT_TOKEN: undefined,
  DISCORD_PUBLIC_KEY: 'test-public-key',
  DISCORD_APP_ID: 'test-app-id',
  DISCORD_CHANNEL_MAP: undefined,
  DISCORD_ENABLED: false,
  INVESTIGATOR_JOB_NAME: 'sower-investigator',
  SCREENSHOT_INVESTIGATION_ENABLED: false,
  RESUME_EDITOR_JOB_NAME: 'sower-resume-editor',
  RESUME_EDITOR_ENABLED: false,
  DASHBOARD_BASE_URL: undefined,
};

/** The paste path never touches the db directly (ingestJob is mocked). */
function createDeps(): Deps {
  const chain: Record<string, unknown> = {};
  for (const method of [
    'from',
    'where',
    'limit',
    'innerJoin',
    'leftJoin',
    'orderBy',
    'values',
    'returning',
    'set',
    'onConflictDoNothing',
  ]) {
    chain[method] = () => chain;
  }
  // biome-ignore lint/suspicious/noThenProperty: mimics drizzle's awaitable builder
  chain.then = (onFulfilled: (value: unknown) => unknown) =>
    Promise.resolve([]).then(onFulfilled);
  const db = {
    select: () => chain,
    insert: () => chain,
    update: () => chain,
  } as unknown as Deps['db'];
  return {
    db,
    queue: { enqueueProcess: vi.fn(async () => {}) },
    config,
    logger: false,
  };
}

function inject(app: ReturnType<typeof buildServer>, payload: unknown) {
  return app.inject({
    method: 'POST',
    url: '/ingest/paste',
    headers: { 'x-api-key': 'test-key' },
    payload: payload as Record<string, unknown>,
  });
}

beforeEach(() => {
  platformState.byUrl = {};
  platformState.adapters = new Set(['greenhouse', 'ashby', 'lever', 'workday']);
  ingestState.known = new Set();
  ingestState.failUrls = new Set();
  ingestState.calls = [];
  ingestState.duplicateTaskId = 'task-dup';
  dirState.byUrl = {};
  triggerState.calls = [];
});

describe('POST /ingest/paste', () => {
  it('responds 401 without an api key (guarded like every route)', async () => {
    const app = buildServer(createDeps());
    const res = await app.inject({
      method: 'POST',
      url: '/ingest/paste',
      payload: { text: 'https://gh/1' },
    });
    expect(res.statusCode).toBe(401);
    expect(ingestState.calls).toEqual([]);
  });

  it('responds 400 for an invalid body (missing/empty/oversized text)', async () => {
    const app = buildServer(createDeps());
    for (const payload of [
      {},
      { text: '' },
      { text: 'x'.repeat(50_001) },
      { text: 42 },
    ]) {
      const res = await inject(app, payload);
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: 'invalid body' });
    }
    expect(ingestState.calls).toEqual([]);
  });

  it('responds 200 with zeros when the text contains no urls (the UI messages it)', async () => {
    const app = buildServer(createDeps());
    const res = await inject(app, {
      text: 'met the Acme recruiter, follow up next week',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      ok: true,
      urls: 0,
      ingested: 0,
      duplicates: 0,
      unsupported: 0,
      directories: 0,
      errors: 0,
      truncated: 0,
      outcomes: [],
    });
    expect(ingestState.calls).toEqual([]);
  });

  it("ingests a supported link with source 'manual' and reports the simplified outcome", async () => {
    platformState.byUrl['https://gh/1'] = {
      platform: 'greenhouse',
      tenant: 'acme',
      externalId: '1',
    };
    const app = buildServer(createDeps());
    const res = await inject(app, { text: 'found this: https://gh/1' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      ok: true,
      urls: 1,
      ingested: 1,
      duplicates: 0,
      unsupported: 0,
      directories: 0,
      errors: 0,
      truncated: 0,
      outcomes: [
        {
          url: 'https://gh/1',
          kind: 'ingested',
          taskId: 'task-1',
          platform: 'greenhouse',
        },
      ],
    });
    // The whole point of the source parameter: dashboard pastes are 'manual'.
    expect(ingestState.calls).toEqual([
      { url: 'https://gh/1', source: 'manual' },
    ]);
  });

  it('reports a duplicate with the original task id (omitted when the job has none)', async () => {
    platformState.byUrl['https://gh/1'] = {
      platform: 'greenhouse',
      tenant: 'acme',
      externalId: '1',
    };
    ingestState.known = new Set(['https://gh/1']);
    const app = buildServer(createDeps());

    const res = await inject(app, { text: 'https://gh/1' });
    expect(res.json()).toMatchObject({
      duplicates: 1,
      outcomes: [
        { url: 'https://gh/1', kind: 'duplicate', taskId: 'task-dup' },
      ],
    });

    // A duplicate whose job somehow has no task: taskId is simply absent.
    ingestState.duplicateTaskId = null;
    const res2 = await inject(app, { text: 'https://gh/1' });
    expect(res2.json().outcomes).toEqual([
      { url: 'https://gh/1', kind: 'duplicate' },
    ]);
  });

  it('parks an unsupported link (recorded, never dropped) and fires form discovery', async () => {
    // https://weirdats/x stays unknown (byUrl fallback) with no page fixture.
    const app = buildServer(createDeps());
    const res = await inject(app, { text: 'https://weirdats/x' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      ok: true,
      urls: 1,
      unsupported: 1,
      outcomes: [
        { url: 'https://weirdats/x', kind: 'unsupported', taskId: 'task-1' },
      ],
    });
    expect(ingestState.calls).toEqual([
      { url: 'https://weirdats/x', source: 'manual' },
    ]);
    // Depth-0 unsupported links trigger the investigator, same as Discord.
    expect(triggerState.calls).toEqual(['task-1']);
  });

  it('flattens directory children one level, each with its own kind', async () => {
    platformState.byUrl['https://gh/2'] = {
      platform: 'greenhouse',
      tenant: 'a',
      externalId: '2',
    };
    dirState.byUrl['https://dir/list'] = [
      'https://gh/2',
      'https://weird/child',
    ];
    const app = buildServer(createDeps());
    const res = await inject(app, { text: 'board: https://dir/list' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      urls: 1,
      ingested: 1,
      unsupported: 1,
      directories: 1,
      errors: 0,
    });
    expect(res.json().outcomes).toEqual([
      { url: 'https://dir/list', kind: 'directory' },
      {
        url: 'https://gh/2',
        kind: 'ingested',
        taskId: 'task-1',
        platform: 'greenhouse',
      },
      { url: 'https://weird/child', kind: 'unsupported', taskId: 'task-1' },
    ]);
    // Directory children never fire the investigator (same as Discord).
    expect(triggerState.calls).toEqual([]);
    // Every child ingest carried the manual source too.
    expect(ingestState.calls.map((c) => c.source)).toEqual([
      'manual',
      'manual',
    ]);
  });

  it('reports a failed url as an error outcome without dropping the rest', async () => {
    platformState.byUrl['https://gh/1'] = {
      platform: 'greenhouse',
      tenant: 'acme',
      externalId: '1',
    };
    platformState.byUrl['https://gh/9'] = {
      platform: 'greenhouse',
      tenant: 'acme',
      externalId: '9',
    };
    ingestState.failUrls = new Set(['https://gh/9']);
    const app = buildServer(createDeps());
    const res = await inject(app, { text: 'https://gh/9 https://gh/1' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      urls: 2,
      ingested: 1,
      errors: 1,
    });
    expect(res.json().outcomes).toEqual([
      { url: 'https://gh/9', kind: 'error', error: 'boom: upstream 500' },
      {
        url: 'https://gh/1',
        kind: 'ingested',
        taskId: 'task-1',
        platform: 'greenhouse',
      },
    ]);
  });

  it('reports urls beyond the 25-per-message cap as truncated (never silently dropped)', async () => {
    for (let i = 1; i <= 28; i += 1) {
      platformState.byUrl[`https://gh/${i}`] = {
        platform: 'greenhouse',
        tenant: 'acme',
        externalId: String(i),
      };
    }
    const text = Array.from(
      { length: 28 },
      (_, i) => `https://gh/${i + 1}`,
    ).join(' ');
    const app = buildServer(createDeps());
    const res = await inject(app, { text });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      urls: 25,
      ingested: 25,
      truncated: 3,
    });
    expect(ingestState.calls).toHaveLength(25);
  });
});
