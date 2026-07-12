import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from './config.js';
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
}));

const sourcesState = vi.hoisted(() => ({
  listings: [] as Array<{
    url: string;
    company_name: string;
    title: string;
    terms: string[];
  }>,
}));

vi.mock('@sower/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@sower/core')>()),
  canonicalizeUrl: (url: string) => url.toLowerCase().replace(/\/+$/, ''),
}));

vi.mock('@sower/platforms', () => ({
  detectPlatform: (url: string) =>
    platformState.byUrl[url] ?? platformState.ref,
  resolveUrl: async (url: string) => url,
  // Only greenhouse has an adapter, mirroring the real registry.
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

vi.mock('@sower/sources', () => ({
  fetchSimplifyListings: async () => sourcesState.listings,
  filterListings: (listings: unknown[]) => listings,
}));

interface Chain {
  from: () => Chain;
  where: () => Chain;
  limit: () => Chain;
  innerJoin: () => Chain;
  leftJoin: () => Chain;
  orderBy: () => Chain;
  values: () => Chain;
  returning: () => Chain;
  set: () => Chain;
  then: (onFulfilled: (value: unknown) => unknown) => Promise<unknown>;
}

function chain(result: unknown): Chain {
  const self: Chain = {
    from: () => self,
    where: () => self,
    limit: () => self,
    innerJoin: () => self,
    leftJoin: () => self,
    orderBy: () => self,
    values: () => self,
    returning: () => self,
    set: () => self,
    // biome-ignore lint/suspicious/noThenProperty: intentionally thenable to mimic drizzle's awaitable query builder
    then: (onFulfilled) => Promise.resolve(result).then(onFulfilled),
  };
  return self;
}

function createFakeDb(
  options: { selectResults?: unknown[][]; insertResults?: unknown[][] } = {},
): Deps['db'] {
  const selectResults = [...(options.selectResults ?? [])];
  const insertResults = [...(options.insertResults ?? [])];
  const db = {
    select: () => chain(selectResults.shift() ?? []),
    insert: () => chain(insertResults.shift() ?? []),
    update: () => chain([]),
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
  SIMPLIFY_TERMS: 'Summer 2027',
  SIMPLIFY_MAX_PER_RUN: 10,
  SOWER_SUBMIT_ENABLED: 'false',
  SOWER_ENV: 'test',
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
  sourcesState.listings = [];
});

describe('buildServer', () => {
  it('GET /healthz responds 200 without an api key', async () => {
    const { deps } = createDeps(createFakeDb());
    const app = buildServer(deps);
    const res = await app.inject({ method: 'GET', url: '/healthz' });
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
    const db = createFakeDb({ selectResults: [[{ id: 'job-1' }]] });
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
      platform: 'lever',
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
      payload: { url: 'https://jobs.lever.co/acme/abc-123' },
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

  it('POST /sources/simplify/poll only ingests greenhouse listings with a known tenant', async () => {
    sourcesState.listings = [
      {
        url: 'https://boards.greenhouse.io/acme/jobs/123',
        company_name: 'Acme',
        title: 'SWE Intern',
        terms: ['Summer 2027'],
      },
      {
        url: 'https://jobs.example.com/opening?gh_jid=42',
        company_name: 'Example',
        title: 'SWE Intern',
        terms: ['Summer 2027'],
      },
      {
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
      selectResults: [[]],
      insertResults: [[{ id: 'job-1' }], [{ id: 'task-1' }]],
    });
    const { deps, enqueueProcess } = createDeps(db);
    const app = buildServer(deps);
    const res = await app.inject({
      method: 'POST',
      url: '/sources/simplify/poll',
      headers: { 'x-api-key': 'test-key' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      scanned: 3,
      matchedGreenhouse: 1,
      ingested: 1,
      duplicates: 0,
    });
    expect(enqueueProcess).toHaveBeenCalledTimes(1);
    expect(enqueueProcess).toHaveBeenCalledWith('task-1');
  });
});
