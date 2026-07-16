import { applicationTasks, events, investigationRuns, jobs } from '@sower/db';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from './config.js';
import { ingestJob } from './ingest.js';
import { buildServer } from './server.js';
import type { Deps } from './types.js';

const platformState = vi.hoisted(() => ({
  ref: {
    platform: 'greenhouse',
    tenant: 'acme',
    externalId: 'swe-1',
  } as { platform: string; tenant: string | null; externalId: string | null },
  /** Per-URL overrides consulted before the default ref. */
  byUrl: {} as Record<
    string,
    { platform: string; tenant: string | null; externalId: string | null }
  >,
  /** URLs the mocked resolveUrl was asked to resolve (identity resolve). */
  resolveCalls: [] as string[],
}));

const sourcesState = vi.hoisted(() => ({
  /** Raw listings (either schema); the mocked fetchListings normalizes them. */
  listings: [] as Array<{
    url: string;
    company_name: string;
    title: string;
    terms?: string[];
    season?: string;
  }>,
}));

/** Tasks refreshIngestReply was asked to re-render the #ingest reply for. */
const refreshState = vi.hoisted(() => ({ calls: [] as string[] }));

// The refresh primitive is proven in ingest-reply.test.ts; here we only
// assert the endpoints invoke it (it never throws, so a fake fn suffices).
vi.mock('./ingest-reply.js', () => ({
  refreshIngestReply: vi.fn(async (_deps: unknown, taskId: string) => {
    refreshState.calls.push(taskId);
  }),
}));

/** Tasks the manual investigate endpoint asked triggerInvestigation to run. */
const investigateState = vi.hoisted(() => ({
  calls: [] as string[],
  /** What the mocked trigger reports back (self-gated off => false). */
  fired: true,
}));

// The trigger itself is proven in investigate-trigger.test.ts; here we only
// assert the endpoint gates + invokes it (it never throws).
vi.mock('./investigate-trigger.js', () => ({
  triggerInvestigation: vi.fn(async (_deps: unknown, taskId: string) => {
    investigateState.calls.push(taskId);
    return investigateState.fired;
  }),
}));

vi.mock('@sower/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@sower/core')>()),
  canonicalizeUrl: (url: string) => url.toLowerCase().replace(/\/+$/, ''),
}));

vi.mock('@sower/platforms', () => ({
  detectPlatform: (url: string) =>
    platformState.byUrl[url] ?? platformState.ref,
  resolveUrl: async (url: string) => {
    platformState.resolveCalls.push(url);
    return url;
  },
  // Only greenhouse has an adapter in this mock (the real registry also
  // registers ashby/lever — covered by @sower/platforms registry.test.ts).
  getAdapter: (platform: string) =>
    platform === 'greenhouse'
      ? {
          discover: async () => ({
            platform: 'greenhouse',
            tenant: 'acme',
            externalId: 'swe-1',
            title: 'Software Engineer Intern',
            applyUrl: 'https://boards.greenhouse.io/acme/jobs/123',
            questions: [],
          }),
          submit: async () => {
            throw new Error('submit disabled');
          },
        }
      : null,
}));

vi.mock('@sower/answers', () => ({
  loadProfile: async () => ({}),
  resolveAnswers: () => ({ resolved: [], missing: [] }),
}));

// Only the network fetch is mocked: normalizeListing, filterListings, and
// computeDedupeKey are the real implementations.
vi.mock('@sower/sources', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@sower/sources')>();
  return {
    ...actual,
    fetchListings: async () =>
      sourcesState.listings.map((raw) => actual.normalizeListing(raw, 'test')),
  };
});

interface Chain {
  from: () => Chain;
  where: () => Chain;
  limit: () => Chain;
  innerJoin: () => Chain;
  leftJoin: () => Chain;
  orderBy: () => Chain;
  values: (arg?: unknown) => Chain;
  returning: () => Chain;
  set: (arg?: unknown) => Chain;
  onConflictDoNothing: () => Chain;
  then: (onFulfilled: (value: unknown) => unknown) => Promise<unknown>;
}

function chain(result: unknown, onArg?: (arg: unknown) => void): Chain {
  const self: Chain = {
    from: () => self,
    where: () => self,
    limit: () => self,
    innerJoin: () => self,
    leftJoin: () => self,
    orderBy: () => self,
    values: (arg?: unknown) => {
      onArg?.(arg);
      return self;
    },
    returning: () => self,
    set: (arg?: unknown) => {
      onArg?.(arg);
      return self;
    },
    onConflictDoNothing: () => self,
    // biome-ignore lint/suspicious/noThenProperty: intentionally thenable to mimic drizzle's awaitable query builder
    then: (onFulfilled) => Promise.resolve(result).then(onFulfilled),
  };
  return self;
}

/** One recorded write: db.insert(table).values(arg) / db.update(table).set(arg). */
interface DbWrite {
  method: 'insert' | 'update';
  table: unknown;
  arg: unknown;
}

function createFakeDb(
  options: {
    selectResults?: unknown[][];
    insertResults?: unknown[][];
    /** When provided, every insert/update write is recorded here. */
    writes?: DbWrite[];
  } = {},
): Deps['db'] {
  const selectResults = [...(options.selectResults ?? [])];
  const insertResults = [...(options.insertResults ?? [])];
  const db = {
    select: () => chain(selectResults.shift() ?? []),
    insert: (table: unknown) =>
      chain(insertResults.shift() ?? [], (arg) =>
        options.writes?.push({ method: 'insert', table, arg }),
      ),
    update: (table: unknown) =>
      chain([], (arg) =>
        options.writes?.push({ method: 'update', table, arg }),
      ),
  };
  return db as unknown as Deps['db'];
}

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
  SOWER_SUBMIT_ENABLED: 'false',
  SOWER_ENV: 'test',
  DISCORD_BOT_TOKEN: undefined,
  DISCORD_PUBLIC_KEY: 'test-public-key',
  DISCORD_APP_ID: 'test-app-id',
  DISCORD_CHANNEL_MAP: undefined,
  DISCORD_ENABLED: false,
  INVESTIGATOR_JOB_NAME: 'sower-investigator',
  SCREENSHOT_INVESTIGATION_ENABLED: false,
  DASHBOARD_BASE_URL: undefined,
};

function createDeps(db: Deps['db']) {
  const enqueueProcess = vi.fn(async (_taskId: string) => {});
  const deps: Deps = { db, queue: { enqueueProcess }, config, logger: false };
  return { deps, enqueueProcess };
}

beforeEach(() => {
  platformState.ref = {
    platform: 'greenhouse',
    tenant: 'acme',
    externalId: 'swe-1',
  };
  platformState.byUrl = {};
  platformState.resolveCalls = [];
  sourcesState.listings = [];
  refreshState.calls = [];
  investigateState.calls = [];
  investigateState.fired = true;
});

describe('buildServer', () => {
  it('GET /health responds 200 without an api key', async () => {
    const { deps } = createDeps(createFakeDb());
    const app = buildServer(deps);
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, env: 'test' });
  });

  it('GET /tasks responds 401 without an api key', async () => {
    const { deps } = createDeps(createFakeDb());
    const app = buildServer(deps);
    const res = await app.inject({ method: 'GET', url: '/tasks' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'unauthorized' });
  });

  it('POST /discord/interactions is exempt from the x-api-key guard', async () => {
    const { deps } = createDeps(createFakeDb()); // no notifier wired
    const app = buildServer(deps);
    const res = await app.inject({
      method: 'POST',
      url: '/discord/interactions',
      payload: JSON.stringify({ type: 1 }),
      headers: { 'content-type': 'application/json' },
    });
    // 503 (notifier not configured), NOT 401: the api-key guard skipped it.
    // Signature-verified handling is covered in discord.test.ts.
    expect(res.statusCode).toBe(503);
  });

  it('GET /tasks responds with rows when the api key is provided', async () => {
    const row = {
      id: 'task-1',
      state: 'REVIEW',
      company: 'Acme',
      title: 'Software Engineer Intern',
      platform: 'greenhouse',
      url: 'https://boards.greenhouse.io/acme/jobs/123',
      updatedAt: '2026-07-11T00:00:00.000Z',
    };
    const { deps } = createDeps(createFakeDb({ selectResults: [[row]] }));
    const app = buildServer(deps);
    const res = await app.inject({
      method: 'GET',
      url: '/tasks',
      headers: { 'x-api-key': 'test-key' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ tasks: [row] });
  });

  it('POST /ingest ingests a new job, enqueues it, and responds 201', async () => {
    const db = createFakeDb({
      selectResults: [[]], // no duplicate
      insertResults: [[{ id: 'job-1' }], [{ id: 'task-1' }]],
    });
    const { deps, enqueueProcess } = createDeps(db);
    const app = buildServer(deps);
    const res = await app.inject({
      method: 'POST',
      url: '/ingest',
      headers: { 'x-api-key': 'test-key' },
      payload: { url: 'https://boards.greenhouse.io/acme/jobs/123' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({
      jobId: 'job-1',
      taskId: 'task-1',
      state: 'QUEUED',
    });
    expect(enqueueProcess).toHaveBeenCalledTimes(1);
    expect(enqueueProcess).toHaveBeenCalledWith('task-1');
  });

  it('POST /ingest responds 200 duplicate for an already-ingested url', async () => {
    // Two selects on the duplicate path: the existing job row (with its
    // provenance), then its earliest task (empty here -> taskId null).
    const db = createFakeDb({
      selectResults: [
        [{ id: 'job-1', source: 'manual', createdAt: new Date() }],
        [],
      ],
    });
    const { deps, enqueueProcess } = createDeps(db);
    const app = buildServer(deps);
    const res = await app.inject({
      method: 'POST',
      url: '/ingest',
      headers: { 'x-api-key': 'test-key' },
      payload: { url: 'https://boards.greenhouse.io/acme/jobs/123' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ duplicate: true, jobId: 'job-1' });
    expect(enqueueProcess).not.toHaveBeenCalled();
  });

  it('POST /ingest responds 200 duplicate when the dedupe_key conflicts (same job, different URL)', async () => {
    // boards.greenhouse.io vs job-boards.greenhouse.io: different canonical
    // URL (fast-path select misses), identical dedupe_key -> ON CONFLICT
    // DO NOTHING inserts no row and the existing job is looked up by key.
    const db = createFakeDb({
      selectResults: [
        [], // no canonical-url duplicate
        // existing row found by dedupe_key
        [{ id: 'job-1', source: 'manual', createdAt: new Date() }],
        [{ id: 'task-orig' }], // the existing job's earliest task
      ],
      insertResults: [[]], // ON CONFLICT (dedupe_key) DO NOTHING: no row
    });
    const { deps, enqueueProcess } = createDeps(db);
    const app = buildServer(deps);
    const res = await app.inject({
      method: 'POST',
      url: '/ingest',
      headers: { 'x-api-key': 'test-key' },
      payload: { url: 'https://job-boards.greenhouse.io/acme/jobs/123' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ duplicate: true, jobId: 'job-1' });
    expect(enqueueProcess).not.toHaveBeenCalled();
  });

  it('POST /ingest parks unknown-platform jobs in NEEDS_INPUT without enqueueing', async () => {
    platformState.ref = { platform: 'unknown', tenant: null, externalId: null };
    const db = createFakeDb({
      selectResults: [[]],
      insertResults: [[{ id: 'job-2' }], [{ id: 'task-2' }]],
    });
    const { deps, enqueueProcess } = createDeps(db);
    const app = buildServer(deps);
    const res = await app.inject({
      method: 'POST',
      url: '/ingest',
      headers: { 'x-api-key': 'test-key' },
      payload: { url: 'https://example.com/careers/some-job' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({
      jobId: 'job-2',
      taskId: 'task-2',
      state: 'NEEDS_INPUT',
    });
    expect(enqueueProcess).not.toHaveBeenCalled();
  });

  it('POST /ingest responds 401 for a wrong api key (same and different length)', async () => {
    const { deps } = createDeps(createFakeDb());
    const app = buildServer(deps);
    for (const key of ['test-kez', 'wrong', 'test-key-longer', '']) {
      const res = await app.inject({
        method: 'POST',
        url: '/ingest',
        headers: { 'x-api-key': key },
        payload: { url: 'https://boards.greenhouse.io/acme/jobs/123' },
      });
      expect(res.statusCode).toBe(401);
    }
  });

  it('POST /ingest parks greenhouse jobs without a tenant (gh_jid on custom domain)', async () => {
    platformState.ref = {
      platform: 'greenhouse',
      tenant: null,
      externalId: '4141773008',
    };
    const db = createFakeDb({
      selectResults: [[]],
      insertResults: [[{ id: 'job-3' }], [{ id: 'task-3' }]],
    });
    const { deps, enqueueProcess } = createDeps(db);
    const app = buildServer(deps);
    const res = await app.inject({
      method: 'POST',
      url: '/ingest',
      headers: { 'x-api-key': 'test-key' },
      payload: { url: 'https://jobs.example.com/openings?gh_jid=4141773008' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({
      jobId: 'job-3',
      taskId: 'task-3',
      state: 'NEEDS_INPUT',
    });
    expect(enqueueProcess).not.toHaveBeenCalled();
  });

  it('POST /ingest parks platforms without a registered adapter', async () => {
    platformState.ref = {
      platform: 'workday',
      tenant: 'acme',
      externalId: 'abc-123',
    };
    const db = createFakeDb({
      selectResults: [[]],
      insertResults: [[{ id: 'job-4' }], [{ id: 'task-4' }]],
    });
    const { deps, enqueueProcess } = createDeps(db);
    const app = buildServer(deps);
    const res = await app.inject({
      method: 'POST',
      url: '/ingest',
      headers: { 'x-api-key': 'test-key' },
      payload: {
        url: 'https://acme.wd1.myworkdayjobs.com/en-US/acme/job/abc-123',
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({
      jobId: 'job-4',
      taskId: 'task-4',
      state: 'NEEDS_INPUT',
    });
    expect(enqueueProcess).not.toHaveBeenCalled();
  });

  it('POST /ingest responds 400 for an invalid body', async () => {
    const { deps } = createDeps(createFakeDb());
    const app = buildServer(deps);
    const res = await app.inject({
      method: 'POST',
      url: '/ingest',
      headers: { 'x-api-key': 'test-key' },
      payload: { url: 'not-a-url' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST /tasks/process responds 200 notFound for a deleted task (no Cloud Tasks retry)', async () => {
    const db = createFakeDb({ selectResults: [[]] });
    const { deps } = createDeps(db);
    const app = buildServer(deps);
    const res = await app.inject({
      method: 'POST',
      url: '/tasks/process',
      headers: { 'x-api-key': 'test-key' },
      payload: { taskId: '7d8e9f10-1112-4314-a516-b71819c2d2e2' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ notFound: true });
  });

  it('POST /tasks/process responds 200 skipped when the task is not claimable', async () => {
    const db = createFakeDb({
      selectResults: [
        [
          {
            task: { id: 'task-1', state: 'REVIEW', attempt: 1, jobId: 'job-1' },
            job: { id: 'job-1', platform: 'greenhouse', url: 'u' },
          },
        ],
      ],
    });
    const { deps } = createDeps(db);
    const app = buildServer(deps);
    const res = await app.inject({
      method: 'POST',
      url: '/tasks/process',
      headers: { 'x-api-key': 'test-key' },
      payload: { taskId: '7d8e9f10-1112-4314-a516-b71819c2d2e2' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ skipped: true, state: 'REVIEW' });
  });

  it('POST /sources/simplify/poll normalizes both raw schemas and only ingests greenhouse listings with a known tenant', async () => {
    sourcesState.listings = [
      {
        // SimplifyJobs schema (terms[]) — greenhouse with tenant: ingested.
        url: 'https://boards.greenhouse.io/acme/jobs/123',
        company_name: 'Acme',
        title: 'SWE Intern',
        terms: ['Summer 2027'],
      },
      {
        // vanshb03 schema (season word) matches the requested 'Summer 2027';
        // greenhouse with tenant: ingested.
        url: 'https://boards.greenhouse.io/globex/jobs/456',
        company_name: 'Globex',
        title: 'SWE Intern',
        season: 'Summer',
      },
      {
        // Wrong term entirely: filtered out before platform matching.
        url: 'https://boards.greenhouse.io/other/jobs/789',
        company_name: 'Other',
        title: 'SWE Intern',
        terms: ['Fall 2028'],
      },
      {
        // greenhouse without tenant (gh_jid custom domain): skipped.
        url: 'https://jobs.example.com/opening?gh_jid=42',
        company_name: 'Example',
        title: 'SWE Intern',
        terms: ['Summer 2027'],
      },
      {
        // Non-greenhouse: counted per-platform, not auto-ingested.
        url: 'https://jobs.lever.co/other/xyz',
        company_name: 'Other',
        title: 'SWE Intern',
        terms: ['Summer 2027'],
      },
    ];
    platformState.byUrl = {
      'https://boards.greenhouse.io/acme/jobs/123': {
        platform: 'greenhouse',
        tenant: 'acme',
        externalId: '123',
      },
      'https://boards.greenhouse.io/globex/jobs/456': {
        platform: 'greenhouse',
        tenant: 'globex',
        externalId: '456',
      },
      'https://jobs.example.com/opening?gh_jid=42': {
        platform: 'greenhouse',
        tenant: null,
        externalId: '42',
      },
      'https://jobs.lever.co/other/xyz': {
        platform: 'lever',
        tenant: 'other',
        externalId: 'xyz',
      },
    };
    const db = createFakeDb({
      // Two ingests: each does a dup-check select, then 4 inserts
      // (job, task, PARSE_OK event, ENQUEUE event).
      selectResults: [[], []],
      insertResults: [
        [{ id: 'job-1' }],
        [{ id: 'task-1' }],
        [], // PARSE_OK event
        [], // ENQUEUE event
        [{ id: 'job-2' }],
        [{ id: 'task-2' }],
        [], // PARSE_OK event
        [], // ENQUEUE event
      ],
    });
    const { deps, enqueueProcess } = createDeps(db);
    const app = buildServer(deps);
    const res = await app.inject({
      method: 'POST',
      url: '/sources/simplify/poll',
      headers: { 'x-api-key': 'test-key' },
    });
    expect(res.statusCode).toBe(200);
    // Only greenhouse has an adapter in this mock, so lever is skipped here;
    // the multi-platform expansion is proven in ingest-poll.test.ts.
    expect(res.json()).toEqual({
      scanned: 4,
      byPlatform: { greenhouse: 3, lever: 1 },
      matched: 2,
      ingested: 2,
      duplicates: 0,
      skipped: 2,
    });
    expect(enqueueProcess).toHaveBeenCalledTimes(2);
    expect(enqueueProcess).toHaveBeenNthCalledWith(1, 'task-1');
    expect(enqueueProcess).toHaveBeenNthCalledWith(2, 'task-2');
  });

  describe('POST /tasks/:id/investigation-result', () => {
    const TASK_ID = '7d8e9f10-1112-4314-a516-b71819c2d2e2';
    const APPLY_URL = 'https://boards.greenhouse.io/acme/jobs/999';

    const foundResult = {
      found: true,
      applyUrl: APPLY_URL,
      company: 'Acme',
      title: 'Software Engineer Intern',
      platform: 'greenhouse',
      confidence: 'high',
      notes: 'located on the tenant board',
    };
    const notFoundResult = {
      found: false,
      confidence: 'low',
      notes: 'no verifiable posting located',
    };
    const transcript = [
      { seq: 0, kind: 'assistant_text', text: 'reading the screenshot', ts: 1 },
      {
        seq: 1,
        kind: 'tool_use',
        tool: 'WebSearch',
        input: { query: 'acme swe intern greenhouse' },
        ts: 2,
      },
      { seq: 2, kind: 'tool_result', tool: 'WebSearch', output: 'hits', ts: 3 },
      { seq: 3, kind: 'result', text: 'success', ts: 4 },
    ];

    function inject(
      app: ReturnType<typeof buildServer>,
      payload: unknown,
      id: string = TASK_ID,
    ) {
      return app.inject({
        method: 'POST',
        url: `/tasks/${id}/investigation-result`,
        headers: { 'x-api-key': 'test-key' },
        payload: payload as Record<string, unknown>,
      });
    }

    it('responds 401 without an api key (NOT exempt from the global guard)', async () => {
      const { deps } = createDeps(createFakeDb());
      const app = buildServer(deps);
      const res = await app.inject({
        method: 'POST',
        url: `/tasks/${TASK_ID}/investigation-result`,
        payload: { result: notFoundResult, transcript: [] },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: 'unauthorized' });
    });

    it('found+applyUrl: ingests the url, marks the run found, and records INVESTIGATION_FOUND', async () => {
      const writes: DbWrite[] = [];
      const db = createFakeDb({
        selectResults: [
          [{ id: 'run-1' }], // latest investigation run for the task
          [], // ingestJob's canonical-url dup check: fresh
        ],
        insertResults: [
          [{ id: 'job-9' }], // ingested job
          [{ id: 'task-9' }], // its application task
        ],
        writes,
      });
      const { deps, enqueueProcess } = createDeps(db);
      const app = buildServer(deps);

      const res = await inject(app, { result: foundResult, transcript });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, foundJobId: 'job-9' });

      // The found URL went through the real ingest pipeline (and enqueued).
      const jobInsert = writes.find(
        (w) => w.method === 'insert' && w.table === jobs,
      );
      expect(jobInsert?.arg).toMatchObject({
        url: APPLY_URL,
        source: 'discord-investigation',
      });
      expect(enqueueProcess).toHaveBeenCalledWith('task-9');

      // Timeline annotation on the screenshot task.
      const foundEvent = writes
        .filter((w) => w.method === 'insert' && w.table === events)
        .map((w) => w.arg as Record<string, unknown>)
        .find((arg) => arg.type === 'INVESTIGATION_FOUND');
      expect(foundEvent).toMatchObject({
        taskId: TASK_ID,
        data: {
          applyUrl: APPLY_URL,
          foundJobId: 'job-9',
          company: 'Acme',
          title: 'Software Engineer Intern',
          platform: 'greenhouse',
        },
      });

      // The run persisted the full transcript + result and linked the job.
      const runUpdate = writes.find(
        (w) => w.method === 'update' && w.table === investigationRuns,
      );
      expect(runUpdate?.arg).toMatchObject({
        status: 'found',
        foundJobId: 'job-9',
        result: foundResult,
        transcript,
        error: null,
      });
      const runSet = runUpdate?.arg as { finishedAt?: unknown } | undefined;
      expect(runSet?.finishedAt).toBeInstanceOf(Date);

      // The #ingest reply that announced the task is refreshed (edited).
      expect(refreshState.calls).toEqual([TASK_ID]);
    });

    it('not_found: updates the run, records INVESTIGATION_DONE, and ingests nothing', async () => {
      const writes: DbWrite[] = [];
      const db = createFakeDb({
        selectResults: [[{ id: 'run-1' }]],
        insertResults: [[]], // INVESTIGATION_DONE event insert
        writes,
      });
      const { deps, enqueueProcess } = createDeps(db);
      const app = buildServer(deps);

      const res = await inject(app, { result: notFoundResult, transcript });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
      expect(enqueueProcess).not.toHaveBeenCalled();
      // No job ingested.
      expect(writes.some((w) => w.table === jobs)).toBe(false);

      const doneEvent = writes
        .filter((w) => w.method === 'insert' && w.table === events)
        .map((w) => w.arg as Record<string, unknown>)
        .find((arg) => arg.type === 'INVESTIGATION_DONE');
      expect(doneEvent).toMatchObject({
        taskId: TASK_ID,
        data: {
          notes: 'no verifiable posting located',
          confidence: 'low',
        },
      });

      const runUpdate = writes.find(
        (w) => w.method === 'update' && w.table === investigationRuns,
      );
      expect(runUpdate?.arg).toMatchObject({
        status: 'not_found',
        foundJobId: null,
        result: notFoundResult,
        transcript,
      });
    });

    it('self-heals a missing run row by inserting one before updating it', async () => {
      const writes: DbWrite[] = [];
      const db = createFakeDb({
        selectResults: [[]], // no existing run for the task
        insertResults: [
          [{ id: 'run-new' }], // the self-healed run row
          [], // INVESTIGATION_DONE event
        ],
        writes,
      });
      const { deps } = createDeps(db);
      const app = buildServer(deps);

      const res = await inject(app, { result: notFoundResult, transcript: [] });

      expect(res.statusCode).toBe(200);
      const runInsert = writes.find(
        (w) => w.method === 'insert' && w.table === investigationRuns,
      );
      expect(runInsert?.arg).toEqual({
        taskId: TASK_ID,
        status: 'running',
        kind: 'screenshot',
      });
      const runUpdate = writes.find(
        (w) => w.method === 'update' && w.table === investigationRuns,
      );
      expect(runUpdate?.arg).toMatchObject({
        status: 'not_found',
        kind: 'screenshot',
      });
    });

    it('an ingest failure marks the run error but still responds 200 (no Job retry)', async () => {
      const writes: DbWrite[] = [];
      const db = createFakeDb({
        selectResults: [
          [{ id: 'run-1' }], // latest run
          [], // dup check: fresh
          [], // dedupe-key conflict lookup: nothing
        ],
        insertResults: [[]], // job insert returns no row -> ingestJob throws
        writes,
      });
      const { deps, enqueueProcess } = createDeps(db);
      const app = buildServer(deps);

      const res = await inject(app, { result: foundResult, transcript });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
      expect(enqueueProcess).not.toHaveBeenCalled();
      // No INVESTIGATION_FOUND event without a real ingested job...
      expect(writes.some((w) => w.table === events)).toBe(false);
      // ...but the transcript is still persisted, with the error recorded.
      const runUpdate = writes.find(
        (w) => w.method === 'update' && w.table === investigationRuns,
      );
      expect(runUpdate?.arg).toMatchObject({
        status: 'error',
        error: 'failed to insert job',
        foundJobId: null,
        result: foundResult,
        transcript,
      });
    });

    it('accepts an explicit kind:screenshot payload (same as the legacy body)', async () => {
      const writes: DbWrite[] = [];
      const db = createFakeDb({
        selectResults: [[{ id: 'run-1' }]],
        insertResults: [[]], // INVESTIGATION_DONE event
        writes,
      });
      const { deps } = createDeps(db);
      const app = buildServer(deps);

      const res = await inject(app, {
        kind: 'screenshot',
        result: notFoundResult,
        transcript,
      });

      expect(res.statusCode).toBe(200);
      const runUpdate = writes.find(
        (w) => w.method === 'update' && w.table === investigationRuns,
      );
      expect(runUpdate?.arg).toMatchObject({
        kind: 'screenshot',
        status: 'not_found',
      });
    });

    describe('kind: form (unsupported-link form discovery)', () => {
      const jobRow = {
        id: 'job-u',
        url: 'https://weirdats.example/jobs/1',
        platform: 'unknown',
        tenant: null,
        externalId: null,
        company: 'WeirdCo',
        title: null,
      };
      const discoveredForm = {
        formFound: true,
        applyUrl: 'https://weirdats.example/jobs/1/apply',
        company: 'WeirdCo',
        title: 'Platform Intern',
        questions: [
          {
            id: 'first_name',
            label: 'First name',
            type: 'text',
            required: true,
          },
          { id: 'resume', label: 'Resume', type: 'file', required: true },
          {
            id: 'work_authorization',
            label: 'Are you authorized to work in the US?',
            type: 'select',
            required: true,
            options: [
              { label: 'Yes', value: 'yes' },
              { label: 'No', value: 'no' },
            ],
          },
        ],
        confidence: 'high',
        notes: 'extracted from the apply page',
      };
      const formNotFound = {
        formFound: false,
        applyUrl: 'https://weirdats.example/jobs/1',
        questions: [],
        confidence: 'low',
        notes: 'behind a login wall',
      };
      const formTranscript = [
        {
          seq: 0,
          kind: 'tool_use',
          tool: 'browser.navigate',
          input: { url: 'https://weirdats.example/jobs/1' },
          ts: 1,
        },
        {
          seq: 1,
          kind: 'tool_result',
          tool: 'browser.navigate',
          output: 'HTTP 200',
          ts: 2,
        },
        { seq: 2, kind: 'result', text: 'success', ts: 3 },
      ];

      it('formFound: writes the agent-discovered jobSpec, records FORM_DISCOVERED, and marks the run found (kind form)', async () => {
        const writes: DbWrite[] = [];
        const db = createFakeDb({
          selectResults: [
            [{ id: 'run-1' }], // latest investigation run
            [{ job: jobRow }], // task+job join
          ],
          insertResults: [[]], // FORM_DISCOVERED event
          writes,
        });
        const { deps, enqueueProcess } = createDeps(db);
        const app = buildServer(deps);

        const res = await inject(app, {
          kind: 'form',
          result: discoveredForm,
          transcript: formTranscript,
        });

        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ ok: true });
        // Form mode ingests nothing and enqueues nothing — the task stays
        // parked (NEEDS_INPUT) for human verification.
        expect(enqueueProcess).not.toHaveBeenCalled();
        expect(writes.some((w) => w.table === jobs)).toBe(false);

        // The discovered spec landed on THIS task, marked agent-discovered,
        // with identity from the job row and questions from the agent.
        const taskUpdate = writes.find(
          (w) => w.method === 'update' && w.table === applicationTasks,
        );
        expect(taskUpdate?.arg).toMatchObject({
          jobSpec: {
            platform: 'unknown',
            tenant: '',
            externalId: '',
            title: 'Platform Intern',
            company: 'WeirdCo',
            applyUrl: 'https://weirdats.example/jobs/1/apply',
            questions: discoveredForm.questions,
            discoveredByAgent: true,
          },
        });
        // No state transition rode along with the spec write.
        const taskSet = taskUpdate?.arg as Record<string, unknown> | undefined;
        expect(taskSet?.state).toBeUndefined();

        const discoveredEvent = writes
          .filter((w) => w.method === 'insert' && w.table === events)
          .map((w) => w.arg as Record<string, unknown>)
          .find((arg) => arg.type === 'FORM_DISCOVERED');
        expect(discoveredEvent).toMatchObject({
          taskId: TASK_ID,
          data: {
            questionCount: 3,
            company: 'WeirdCo',
            title: 'Platform Intern',
            confidence: 'high',
          },
        });

        const runUpdate = writes.find(
          (w) => w.method === 'update' && w.table === investigationRuns,
        );
        expect(runUpdate?.arg).toMatchObject({
          kind: 'form',
          status: 'found',
          result: discoveredForm,
          transcript: formTranscript,
          error: null,
        });
        const runSet = runUpdate?.arg as { finishedAt?: unknown } | undefined;
        expect(runSet?.finishedAt).toBeInstanceOf(Date);

        // The #ingest reply that announced the task is refreshed (edited).
        expect(refreshState.calls).toEqual([TASK_ID]);
      });

      it('not found: records FORM_NOT_FOUND, writes no jobSpec, and marks the run not_found', async () => {
        const writes: DbWrite[] = [];
        const db = createFakeDb({
          selectResults: [[{ id: 'run-1' }]],
          insertResults: [[]], // FORM_NOT_FOUND event
          writes,
        });
        const { deps, enqueueProcess } = createDeps(db);
        const app = buildServer(deps);

        const res = await inject(app, {
          kind: 'form',
          result: formNotFound,
          transcript: formTranscript,
        });

        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ ok: true });
        expect(enqueueProcess).not.toHaveBeenCalled();
        // No jobSpec write and no ingest.
        expect(
          writes.some(
            (w) => w.method === 'update' && w.table === applicationTasks,
          ),
        ).toBe(false);
        expect(writes.some((w) => w.table === jobs)).toBe(false);

        const notFoundEvent = writes
          .filter((w) => w.method === 'insert' && w.table === events)
          .map((w) => w.arg as Record<string, unknown>)
          .find((arg) => arg.type === 'FORM_NOT_FOUND');
        expect(notFoundEvent).toMatchObject({
          taskId: TASK_ID,
          data: { notes: 'behind a login wall', confidence: 'low' },
        });

        const runUpdate = writes.find(
          (w) => w.method === 'update' && w.table === investigationRuns,
        );
        expect(runUpdate?.arg).toMatchObject({
          kind: 'form',
          status: 'not_found',
          result: formNotFound,
          transcript: formTranscript,
        });

        // The reply refresh fires on ANY investigation outcome.
        expect(refreshState.calls).toEqual([TASK_ID]);
      });

      it('formFound with a missing task row: still persists the run, as an error', async () => {
        const writes: DbWrite[] = [];
        const db = createFakeDb({
          selectResults: [
            [{ id: 'run-1' }], // latest run
            [], // task+job join: task deleted
          ],
          writes,
        });
        const { deps } = createDeps(db);
        const app = buildServer(deps);

        const res = await inject(app, {
          kind: 'form',
          result: discoveredForm,
          transcript: formTranscript,
        });

        expect(res.statusCode).toBe(200);
        expect(
          writes.some(
            (w) => w.method === 'update' && w.table === applicationTasks,
          ),
        ).toBe(false);
        const runUpdate = writes.find(
          (w) => w.method === 'update' && w.table === investigationRuns,
        );
        expect(runUpdate?.arg).toMatchObject({
          kind: 'form',
          status: 'error',
          error: 'task not found; discovered form not written',
          result: discoveredForm,
          transcript: formTranscript,
        });
      });

      it('responds 400 for a malformed form body', async () => {
        const { deps } = createDeps(createFakeDb());
        const app = buildServer(deps);
        for (const payload of [
          // screenshot-shaped result under kind form
          { kind: 'form', result: notFoundResult, transcript: [] },
          // malformed question (missing label/type/required)
          {
            kind: 'form',
            result: { ...discoveredForm, questions: [{ id: 'x' }] },
            transcript: [],
          },
          // unknown kind
          { kind: 'bogus', result: formNotFound, transcript: [] },
          // form result under (implicit) screenshot kind
          { result: formNotFound, transcript: [] },
        ]) {
          const res = await inject(app, payload);
          expect(res.statusCode).toBe(400);
          expect(res.json()).toMatchObject({ error: 'invalid body' });
        }
      });
    });

    it('responds 400 for an invalid task id', async () => {
      const { deps } = createDeps(createFakeDb());
      const app = buildServer(deps);
      const res = await inject(
        app,
        { result: notFoundResult, transcript: [] },
        'not-a-uuid',
      );
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: 'invalid task id' });
    });

    it('responds 400 for an invalid body', async () => {
      const { deps } = createDeps(createFakeDb());
      const app = buildServer(deps);
      for (const payload of [
        {},
        { result: notFoundResult }, // missing transcript
        { result: { found: 'yes' }, transcript: [] }, // malformed result
        { result: notFoundResult, transcript: 'nope' }, // not an array
      ]) {
        const res = await inject(app, payload);
        expect(res.statusCode).toBe(400);
        expect(res.json()).toMatchObject({ error: 'invalid body' });
      }
    });
  });

  describe('POST /tasks/:id/verify-form', () => {
    const TASK_ID = '7d8e9f10-1112-4314-a516-b71819c2d2e2';
    const discoveredSpec = {
      platform: 'unknown',
      tenant: '',
      externalId: '',
      title: 'Platform Intern',
      company: 'WeirdCo',
      applyUrl: 'https://weirdats.example/jobs/1/apply',
      questions: [
        { id: 'first_name', label: 'First name', type: 'text', required: true },
        { id: 'email', label: 'Email', type: 'text', required: true },
        { id: 'resume', label: 'Resume', type: 'file', required: true },
      ],
      discoveredByAgent: true,
    };

    function inject(app: ReturnType<typeof buildServer>, id: string = TASK_ID) {
      return app.inject({
        method: 'POST',
        url: `/tasks/${id}/verify-form`,
        headers: { 'x-api-key': 'test-key' },
      });
    }

    it('marks the discovered form verified, records FORM_VERIFIED, and refreshes the reply', async () => {
      const writes: DbWrite[] = [];
      const db = createFakeDb({
        selectResults: [[{ id: TASK_ID, jobSpec: discoveredSpec }]],
        insertResults: [[]], // FORM_VERIFIED event
        writes,
      });
      const { deps } = createDeps(db);
      const app = buildServer(deps);

      const res = await inject(app);

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });

      // formVerified merged into the EXISTING spec (nothing else lost).
      const taskUpdate = writes.find(
        (w) => w.method === 'update' && w.table === applicationTasks,
      );
      expect(taskUpdate?.arg).toMatchObject({
        jobSpec: { ...discoveredSpec, formVerified: true },
      });

      const verifiedEvent = writes
        .filter((w) => w.method === 'insert' && w.table === events)
        .map((w) => w.arg as Record<string, unknown>)
        .find((arg) => arg.type === 'FORM_VERIFIED');
      expect(verifiedEvent).toMatchObject({
        taskId: TASK_ID,
        data: {
          questionCount: 3,
          company: 'WeirdCo',
          title: 'Platform Intern',
        },
      });

      // The #ingest reply is edited to the "form verified" line.
      expect(refreshState.calls).toEqual([TASK_ID]);
    });

    it('is idempotent: re-verifying rewrites nothing and adds no second event', async () => {
      const writes: DbWrite[] = [];
      const db = createFakeDb({
        selectResults: [
          [
            {
              id: TASK_ID,
              jobSpec: { ...discoveredSpec, formVerified: true },
            },
          ],
        ],
        writes,
      });
      const { deps } = createDeps(db);
      const app = buildServer(deps);

      const res = await inject(app);

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
      expect(writes).toEqual([]);
      // Still refreshes: recovers a reply whose earlier edit failed.
      expect(refreshState.calls).toEqual([TASK_ID]);
    });

    it('responds 400 when the task has no agent-discovered form', async () => {
      const writes: DbWrite[] = [];
      for (const jobSpec of [
        null,
        { ...discoveredSpec, discoveredByAgent: undefined },
      ]) {
        const db = createFakeDb({
          selectResults: [[{ id: TASK_ID, jobSpec }]],
          writes,
        });
        const { deps } = createDeps(db);
        const app = buildServer(deps);

        const res = await inject(app);

        expect(res.statusCode).toBe(400);
        expect(res.json()).toEqual({ error: 'no discovered form to verify' });
      }
      expect(writes).toEqual([]);
      expect(refreshState.calls).toEqual([]);
    });

    it('responds 404 for a missing task and 400 for an invalid id', async () => {
      const { deps } = createDeps(createFakeDb({ selectResults: [[]] }));
      const app = buildServer(deps);

      const missing = await inject(app);
      expect(missing.statusCode).toBe(404);
      expect(missing.json()).toEqual({ error: 'task not found' });

      const invalid = await inject(app, 'not-a-uuid');
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json()).toMatchObject({ error: 'invalid task id' });
    });

    it('responds 401 without an api key (guarded like every route)', async () => {
      const { deps } = createDeps(createFakeDb());
      const app = buildServer(deps);
      const res = await app.inject({
        method: 'POST',
        url: `/tasks/${TASK_ID}/verify-form`,
      });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('POST /tasks/:id/discard', () => {
    const TASK_ID = '7d8e9f10-1112-4314-a516-b71819c2d2e2';

    function inject(app: ReturnType<typeof buildServer>, id: string = TASK_ID) {
      return app.inject({
        method: 'POST',
        url: `/tasks/${id}/discard`,
        headers: { 'x-api-key': 'test-key' },
      });
    }

    it('discards an active task: DISCARD transition + event, then refreshes the reply', async () => {
      const writes: DbWrite[] = [];
      const db = createFakeDb({
        selectResults: [[{ state: 'NEEDS_INPUT' }]],
        insertResults: [[]], // DISCARD event
        writes,
      });
      const { deps } = createDeps(db);
      const app = buildServer(deps);

      const res = await inject(app);

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });

      const taskUpdate = writes.find(
        (w) => w.method === 'update' && w.table === applicationTasks,
      );
      expect(taskUpdate?.arg).toMatchObject({ state: 'DISCARDED' });

      const discardEvent = writes
        .filter((w) => w.method === 'insert' && w.table === events)
        .map((w) => w.arg as Record<string, unknown>)
        .find((arg) => arg.type === 'DISCARD');
      expect(discardEvent).toMatchObject({
        taskId: TASK_ID,
        fromState: 'NEEDS_INPUT',
        toState: 'DISCARDED',
        data: { reason: 'manual' },
      });

      // The #ingest reply line flips to "discarded".
      expect(refreshState.calls).toEqual([TASK_ID]);
    });

    it('is idempotent: an already-DISCARDED task is a 200 no-op (but still refreshes)', async () => {
      const writes: DbWrite[] = [];
      const db = createFakeDb({
        selectResults: [[{ state: 'DISCARDED' }]],
        writes,
      });
      const { deps } = createDeps(db);
      const app = buildServer(deps);

      const res = await inject(app);

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
      expect(writes).toEqual([]);
      // Recovers a reply whose earlier edit failed.
      expect(refreshState.calls).toEqual([TASK_ID]);
    });

    it('responds 409 for a sent application (SUBMITTED/CONFIRMED)', async () => {
      for (const state of ['SUBMITTED', 'CONFIRMED']) {
        const writes: DbWrite[] = [];
        const db = createFakeDb({ selectResults: [[{ state }]], writes });
        const { deps } = createDeps(db);
        const app = buildServer(deps);

        const res = await inject(app);

        expect(res.statusCode).toBe(409);
        expect(res.json()).toEqual({
          error: `cannot discard a task in state '${state}'`,
        });
        expect(writes).toEqual([]);
      }
      expect(refreshState.calls).toEqual([]);
    });

    it('responds 404 for a missing task and 400 for an invalid id', async () => {
      const { deps } = createDeps(createFakeDb({ selectResults: [[]] }));
      const app = buildServer(deps);

      const missing = await inject(app);
      expect(missing.statusCode).toBe(404);
      expect(missing.json()).toEqual({ error: 'task not found' });

      const invalid = await inject(app, 'not-a-uuid');
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json()).toMatchObject({ error: 'invalid task id' });
    });

    it('responds 401 without an api key (guarded like every route)', async () => {
      const { deps } = createDeps(createFakeDb());
      const app = buildServer(deps);
      const res = await app.inject({
        method: 'POST',
        url: `/tasks/${TASK_ID}/discard`,
      });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('POST /tasks/discard (bulk)', () => {
    const ID_A = '7d8e9f10-1112-4314-a516-b71819c2d2e2';
    const ID_B = 'a1b2c3d4-e5f6-4788-99aa-bbccddeeff00';
    const ID_C = '00112233-4455-4677-8899-aabbccddeeff';

    function inject(app: ReturnType<typeof buildServer>, payload: unknown) {
      return app.inject({
        method: 'POST',
        url: '/tasks/discard',
        headers: { 'x-api-key': 'test-key' },
        payload: payload as Record<string, unknown>,
      });
    }

    it('is tolerant per task: discards what it can and reports the rest as skipped', async () => {
      const writes: DbWrite[] = [];
      const db = createFakeDb({
        selectResults: [
          [{ state: 'QUEUED' }], // A: discardable
          [{ state: 'SUBMITTED' }], // B: sent — skipped
          [], // C: missing — skipped
        ],
        insertResults: [[]], // A's DISCARD event
        writes,
      });
      const { deps } = createDeps(db);
      const app = buildServer(deps);

      const res = await inject(app, { taskIds: [ID_A, ID_B, ID_C] });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        ok: true,
        discarded: 1,
        skipped: [
          { id: ID_B, reason: "cannot discard a task in state 'SUBMITTED'" },
          { id: ID_C, reason: 'task not found' },
        ],
      });

      // Exactly one task transitioned...
      const taskUpdates = writes.filter(
        (w) => w.method === 'update' && w.table === applicationTasks,
      );
      expect(taskUpdates).toHaveLength(1);
      expect(taskUpdates[0]?.arg).toMatchObject({ state: 'DISCARDED' });
      const discardEvents = writes
        .filter((w) => w.method === 'insert' && w.table === events)
        .map((w) => w.arg as Record<string, unknown>)
        .filter((arg) => arg.type === 'DISCARD');
      expect(discardEvents).toHaveLength(1);
      expect(discardEvents[0]).toMatchObject({ taskId: ID_A });
      // ...and only that task's reply was refreshed.
      expect(refreshState.calls).toEqual([ID_A]);
    });

    it('reports an already-discarded task as skipped (nothing rewritten)', async () => {
      const writes: DbWrite[] = [];
      const db = createFakeDb({
        selectResults: [[{ state: 'DISCARDED' }]],
        writes,
      });
      const { deps } = createDeps(db);
      const app = buildServer(deps);

      const res = await inject(app, { taskIds: [ID_A] });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        ok: true,
        discarded: 0,
        skipped: [{ id: ID_A, reason: 'already discarded' }],
      });
      expect(writes).toEqual([]);
    });

    it('responds 400 for an invalid body (missing/empty/non-uuid/oversized)', async () => {
      const { deps } = createDeps(createFakeDb());
      const app = buildServer(deps);
      for (const payload of [
        {},
        { taskIds: [] },
        { taskIds: ['not-a-uuid'] },
        { taskIds: Array.from({ length: 101 }, () => ID_A) },
      ]) {
        const res = await inject(app, payload);
        expect(res.statusCode).toBe(400);
        expect(res.json()).toMatchObject({ error: 'invalid body' });
      }
    });

    it('responds 401 without an api key (guarded like every route)', async () => {
      const { deps } = createDeps(createFakeDb());
      const app = buildServer(deps);
      const res = await app.inject({
        method: 'POST',
        url: '/tasks/discard',
        payload: { taskIds: [ID_A] },
      });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('POST /tasks/:id/investigate', () => {
    const TASK_ID = '7d8e9f10-1112-4314-a516-b71819c2d2e2';

    function taskJobRow(overrides: { state?: string; platform?: string } = {}) {
      return {
        task: { id: TASK_ID, state: overrides.state ?? 'NEEDS_INPUT' },
        job: {
          id: 'job-u',
          platform: overrides.platform ?? 'unknown',
          url: 'https://weirdats.example/jobs/1',
        },
      };
    }

    function inject(app: ReturnType<typeof buildServer>, id: string = TASK_ID) {
      return app.inject({
        method: 'POST',
        url: `/tasks/${id}/investigate`,
        headers: { 'x-api-key': 'test-key' },
      });
    }

    it('fires the browser agent for an unsupported (platform unknown) task', async () => {
      const db = createFakeDb({ selectResults: [[taskJobRow()]] });
      const { deps } = createDeps(db);
      const app = buildServer(deps);

      const res = await inject(app);

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, fired: true });
      expect(investigateState.calls).toEqual([TASK_ID]);
      // The reply reflects "discovering form…" right away.
      expect(refreshState.calls).toEqual([TASK_ID]);
    });

    it('reports fired:false when the trigger self-gates off (and skips the refresh)', async () => {
      investigateState.fired = false;
      const db = createFakeDb({ selectResults: [[taskJobRow()]] });
      const { deps } = createDeps(db);
      const app = buildServer(deps);

      const res = await inject(app);

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, fired: false });
      expect(investigateState.calls).toEqual([TASK_ID]);
      expect(refreshState.calls).toEqual([]);
    });

    it('fires for a supported-platform task whose job has a screenshot document', async () => {
      const db = createFakeDb({
        selectResults: [
          [taskJobRow({ platform: 'greenhouse' })],
          [{ id: 'doc-1' }], // kind='screenshot' document exists
        ],
      });
      const { deps } = createDeps(db);
      const app = buildServer(deps);

      const res = await inject(app);

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, fired: true });
      expect(investigateState.calls).toEqual([TASK_ID]);
    });

    it('responds 400 for a supported-platform task without a screenshot', async () => {
      const db = createFakeDb({
        selectResults: [
          [taskJobRow({ platform: 'greenhouse' })],
          [], // no screenshot documents
        ],
      });
      const { deps } = createDeps(db);
      const app = buildServer(deps);

      const res = await inject(app);

      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({
        error:
          "task is not eligible for investigation: platform 'greenhouse' is supported and the job has no screenshot",
      });
      expect(investigateState.calls).toEqual([]);
    });

    it('responds 400 for a DISCARDED/SUBMITTED/CONFIRMED task', async () => {
      for (const state of ['DISCARDED', 'SUBMITTED', 'CONFIRMED']) {
        const db = createFakeDb({ selectResults: [[taskJobRow({ state })]] });
        const { deps } = createDeps(db);
        const app = buildServer(deps);

        const res = await inject(app);

        expect(res.statusCode).toBe(400);
        expect(res.json()).toEqual({
          error: `cannot investigate a task in state '${state}'`,
        });
      }
      expect(investigateState.calls).toEqual([]);
    });

    it('responds 404 for a missing task and 400 for an invalid id', async () => {
      const { deps } = createDeps(createFakeDb({ selectResults: [[]] }));
      const app = buildServer(deps);

      const missing = await inject(app);
      expect(missing.statusCode).toBe(404);
      expect(missing.json()).toEqual({ error: 'task not found' });

      const invalid = await inject(app, 'not-a-uuid');
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json()).toMatchObject({ error: 'invalid task id' });
    });

    it('responds 401 without an api key (guarded like every route)', async () => {
      const { deps } = createDeps(createFakeDb());
      const app = buildServer(deps);
      const res = await app.inject({
        method: 'POST',
        url: `/tasks/${TASK_ID}/investigate`,
      });
      expect(res.statusCode).toBe(401);
      expect(investigateState.calls).toEqual([]);
    });
  });
});

describe('ingestJob duplicate enrichment', () => {
  it('returns the existing job task, source, and createdAt on a duplicate', async () => {
    const createdAt = new Date('2026-07-13T19:47:00Z');
    const db = createFakeDb({
      selectResults: [
        // The existing job matched by canonical url, with its provenance.
        [
          {
            id: 'job-1',
            source: 'SimplifyJobs/Summer2027-Internships',
            createdAt,
          },
        ],
        [{ id: 'task-orig' }], // its earliest task
      ],
    });
    const { deps, enqueueProcess } = createDeps(db);
    const result = await ingestJob(deps, {
      url: 'https://boards.greenhouse.io/acme/jobs/123',
    });
    expect(result).toEqual({
      duplicate: true,
      jobId: 'job-1',
      taskId: 'task-orig',
      originalSource: 'SimplifyJobs/Summer2027-Internships',
      originalCreatedAt: createdAt,
    });
    expect(enqueueProcess).not.toHaveBeenCalled();
  });

  it('reports taskId null when the existing job somehow has no task', async () => {
    const createdAt = new Date('2026-07-13T19:47:00Z');
    const db = createFakeDb({
      selectResults: [
        [{ id: 'job-1', source: 'discord', createdAt }],
        [], // no application_tasks row
      ],
    });
    const { deps } = createDeps(db);
    const result = await ingestJob(deps, {
      url: 'https://boards.greenhouse.io/acme/jobs/123',
    });
    expect(result).toEqual({
      duplicate: true,
      jobId: 'job-1',
      taskId: null,
      originalSource: 'discord',
      originalCreatedAt: createdAt,
    });
  });
});

describe('ingestJob pre-resolve detection', () => {
  it('skips resolveUrl when the input URL already detects as a supported posting', async () => {
    // Default mock ref: greenhouse/acme — discoverable straight from the URL.
    const db = createFakeDb({
      selectResults: [[]], // no duplicate
      insertResults: [[{ id: 'job-1' }], [{ id: 'task-1' }]],
    });
    const { deps, enqueueProcess } = createDeps(db);
    const result = await ingestJob(deps, {
      url: 'https://job-boards.greenhouse.io/acme/jobs/123',
    });
    expect(result).toMatchObject({ duplicate: false, state: 'QUEUED' });
    expect(enqueueProcess).toHaveBeenCalledWith('task-1');
    // The whole point: the board URL is never GETed, so a custom-domain
    // redirect (job-boards.greenhouse.io/stripe → stripe.com) cannot strip
    // the platform identity before detection.
    expect(platformState.resolveCalls).toEqual([]);
  });

  it('still resolves an unknown-platform URL before detecting', async () => {
    platformState.ref = { platform: 'unknown', tenant: null, externalId: null };
    const db = createFakeDb({
      selectResults: [[]],
      insertResults: [[{ id: 'job-2' }], [{ id: 'task-2' }]],
    });
    const { deps } = createDeps(db);
    const result = await ingestJob(deps, {
      url: 'https://example.com/careers/some-job',
    });
    expect(result).toMatchObject({ duplicate: false, state: 'NEEDS_INPUT' });
    expect(platformState.resolveCalls).toEqual([
      'https://example.com/careers/some-job',
    ]);
  });

  it('never resolves when resolve:false, even for an unknown URL', async () => {
    platformState.ref = { platform: 'unknown', tenant: null, externalId: null };
    const db = createFakeDb({
      selectResults: [[]],
      insertResults: [[{ id: 'job-3' }], [{ id: 'task-3' }]],
    });
    const { deps } = createDeps(db);
    await ingestJob(deps, {
      url: 'https://cdn.discordapp.com/attachments/1/2/shot.png',
      resolve: false,
    });
    expect(platformState.resolveCalls).toEqual([]);
  });
});
