import { createHash } from 'node:crypto';
import {
  applicationTasks,
  events,
  investigationRuns,
  jobDescriptions,
  jobs,
} from '@sower/db';
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

/** Overrides for the mocked greenhouse adapter's discovered spec. */
const adapterResultState = vi.hoisted(() => ({
  title: undefined as string | undefined,
  employmentType: undefined as string | undefined,
}));

/** Verified greenhouse tenant probe: what it reports + how it was called. */
const probeState = vi.hoisted(() => ({
  tenant: null as string | null,
  calls: [] as Array<{ url: string; jobId: string }>,
}));

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
  // Verified tenant probe (unit-tested in @sower/platforms); null = no
  // verified tenant, so tenant-less greenhouse ingests park exactly as before.
  deriveGreenhouseTenant: async (url: string, jobId: string) => {
    probeState.calls.push({ url, jobId });
    return probeState.tenant;
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
            title: adapterResultState.title ?? 'Software Engineer Intern',
            applyUrl: 'https://boards.greenhouse.io/acme/jobs/123',
            questions: [],
            ...(adapterResultState.employmentType !== undefined
              ? { employmentType: adapterResultState.employmentType }
              : {}),
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
    /** Rows update(...).returning() resolves (e.g. processTask's claim). */
    updateResults?: unknown[][];
    /** When provided, every insert/update write is recorded here. */
    writes?: DbWrite[];
  } = {},
): Deps['db'] {
  const selectResults = [...(options.selectResults ?? [])];
  const insertResults = [...(options.insertResults ?? [])];
  const updateResults = [...(options.updateResults ?? [])];
  const db = {
    select: () => chain(selectResults.shift() ?? []),
    insert: (table: unknown) =>
      chain(insertResults.shift() ?? [], (arg) =>
        options.writes?.push({ method: 'insert', table, arg }),
      ),
    update: (table: unknown) =>
      chain(updateResults.shift() ?? [], (arg) =>
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
  RESUME_EDITOR_JOB_NAME: 'sower-resume-editor',
  RESUME_EDITOR_ENABLED: false,
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
  adapterResultState.title = undefined;
  adapterResultState.employmentType = undefined;
  investigateState.calls = [];
  investigateState.fired = true;
  probeState.tenant = null;
  probeState.calls = [];
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

  it('POST /ingest parks greenhouse jobs without a tenant when the probe finds none', async () => {
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
    // The probe WAS consulted (with the resolved URL + job id) and reported
    // no verified tenant — only then did the task park.
    expect(probeState.calls).toEqual([
      {
        url: 'https://jobs.example.com/openings?gh_jid=4141773008',
        jobId: '4141773008',
      },
    ]);
  });

  it('POST /ingest queues a tenant-less greenhouse job the probe verifies, stored under the canonical board URL', async () => {
    // The akuna shape: gh_jid on the company's own domain. detectPlatform
    // sees greenhouse without a tenant; the probe verifies 'akunacapital'.
    const pageUrl =
      'https://akunacapital.com/careers/job/8018853/swe?gh_jid=8018853';
    const canonical =
      'https://job-boards.greenhouse.io/akunacapital/jobs/8018853';
    platformState.byUrl[pageUrl] = {
      platform: 'greenhouse',
      tenant: null,
      externalId: '8018853',
    };
    platformState.byUrl[canonical] = {
      platform: 'greenhouse',
      tenant: 'akunacapital',
      externalId: '8018853',
    };
    probeState.tenant = 'akunacapital';
    const writes: DbWrite[] = [];
    const db = createFakeDb({
      selectResults: [[]], // no canonical-url duplicate
      insertResults: [[{ id: 'job-5' }], [{ id: 'task-5' }]],
      writes,
    });
    const { deps, enqueueProcess } = createDeps(db);
    const app = buildServer(deps);

    const res = await app.inject({
      method: 'POST',
      url: '/ingest',
      headers: { 'x-api-key': 'test-key' },
      payload: { url: pageUrl },
    });

    // A SUPPORTED ingest: queued + enqueued, never parked.
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({
      jobId: 'job-5',
      taskId: 'task-5',
      state: 'QUEUED',
    });
    expect(enqueueProcess).toHaveBeenCalledWith('task-5');
    expect(probeState.calls).toEqual([{ url: pageUrl, jobId: '8018853' }]);
    // The stored job row carries the canonical board URL + verified tenant
    // (like the discord sniff path), so board-hosted pastes dedupe onto it.
    const jobInsert = writes.find(
      (write) => write.method === 'insert' && write.table === jobs,
    );
    expect(jobInsert?.arg).toMatchObject({
      url: canonical,
      canonicalUrl: canonical,
      platform: 'greenhouse',
      tenant: 'akunacapital',
      externalId: '8018853',
      dedupeKey: 'greenhouse:akunacapital:8018853',
    });
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

  it('POST /tasks/process responds 200 for an auto-discarded full-time role (no Cloud Tasks retry)', async () => {
    // A full-time posting whose titles nowhere say intern: the parse discards
    // it. The 200 is the no-retry contract — Cloud Tasks must treat the
    // auto-discard as final, exactly like notFound/skipped/gaveUp.
    adapterResultState.title = 'Staff Software Engineer';
    adapterResultState.employmentType = 'Full time';
    const writes: DbWrite[] = [];
    const db = createFakeDb({
      selectResults: [
        [
          {
            task: { id: 'task-1', state: 'QUEUED', attempt: 0, jobId: 'job-1' },
            job: {
              id: 'job-1',
              platform: 'greenhouse',
              tenant: 'acme',
              externalId: 'swe-1',
              url: 'https://boards.greenhouse.io/acme/jobs/123',
              company: 'Acme',
              title: null,
            },
          },
        ],
        [], // RESTORE-event guard: no restore in the history
      ],
      updateResults: [
        // The atomic claim wins and returns the claimed row.
        [{ id: 'task-1', state: 'PREPARING', attempt: 1, jobId: 'job-1' }],
      ],
      writes,
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
    expect(res.json()).toEqual({
      autoDiscarded: true,
      state: 'DISCARDED',
      employmentType: 'Full time',
    });
    // The DISCARD event carried the queryable reason/note data.
    const discardEvent = writes
      .filter((w) => w.method === 'insert' && w.table === events)
      .map((w) => w.arg as Record<string, unknown>)
      .find((arg) => arg.type === 'DISCARD');
    expect(discardEvent).toMatchObject({
      toState: 'DISCARDED',
      data: { reason: 'auto', note: 'Employment type: Full time' },
    });
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
        deadline: null,
      };
      // The task half of the endpoint's task+job join (jobSpec is what the
      // not_found employmentType merge reads).
      const taskRow = { id: TASK_ID, jobSpec: null };
      const joinRow = { task: taskRow, job: jobRow };
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
            [joinRow], // task+job join
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
        expect(
          writes.some((w) => w.method === 'insert' && w.table === jobs),
        ).toBe(false);

        // The jobs row's blank title is backfilled from the agent's finding;
        // the ingest-recorded company ('WeirdCo') is never overwritten, so
        // the update carries exactly the missing field.
        const jobUpdate = writes.find(
          (w) => w.method === 'update' && w.table === jobs,
        );
        expect(jobUpdate?.arg).toEqual({ title: 'Platform Intern' });

        // No descriptionMarkdown on this result — no job_descriptions row.
        expect(
          writes.some(
            (w) => w.method === 'insert' && w.table === jobDescriptions,
          ),
        ).toBe(false);

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

      it('persists descriptionMarkdown as the next job_descriptions version', async () => {
        const markdown = '## About the role\n\nBuild weird ATS integrations.';
        const writes: DbWrite[] = [];
        const db = createFakeDb({
          selectResults: [
            [{ id: 'run-1' }], // latest run
            [joinRow], // task+job join
            // Latest stored description for the job: version 2, other content.
            [{ version: 2, contentHash: 'someotherhash' }],
          ],
          insertResults: [[]], // FORM_DISCOVERED event
          writes,
        });
        const { deps } = createDeps(db);
        const app = buildServer(deps);

        const res = await inject(app, {
          kind: 'form',
          result: { ...discoveredForm, descriptionMarkdown: markdown },
          transcript: formTranscript,
        });

        expect(res.statusCode).toBe(200);
        const descriptionInsert = writes.find(
          (w) => w.method === 'insert' && w.table === jobDescriptions,
        );
        // Same versioning contract as processTask's adapter descriptions:
        // next version = max + 1, content is the markdown verbatim.
        expect(descriptionInsert?.arg).toEqual({
          jobId: 'job-u',
          version: 3,
          content: markdown,
          contentHash: createHash('sha256').update(markdown).digest('hex'),
        });
      });

      it('persists descriptionMarkdown as version 1 when the job has no stored description', async () => {
        const markdown = 'Plain paragraph JD.';
        const writes: DbWrite[] = [];
        const db = createFakeDb({
          selectResults: [
            [{ id: 'run-1' }],
            [joinRow],
            [], // no job_descriptions rows yet
          ],
          insertResults: [[]],
          writes,
        });
        const { deps } = createDeps(db);
        const app = buildServer(deps);

        const res = await inject(app, {
          kind: 'form',
          result: { ...discoveredForm, descriptionMarkdown: markdown },
          transcript: formTranscript,
        });

        expect(res.statusCode).toBe(200);
        const descriptionInsert = writes.find(
          (w) => w.method === 'insert' && w.table === jobDescriptions,
        );
        expect(descriptionInsert?.arg).toMatchObject({
          jobId: 'job-u',
          version: 1,
          content: markdown,
        });
      });

      it('rejects a descriptionMarkdown beyond the 25k cap', async () => {
        const { deps } = createDeps(createFakeDb());
        const app = buildServer(deps);
        const res = await inject(app, {
          kind: 'form',
          result: {
            ...discoveredForm,
            descriptionMarkdown: 'x'.repeat(25_001),
          },
          transcript: [],
        });
        expect(res.statusCode).toBe(400);
        expect(res.json()).toMatchObject({ error: 'invalid body' });
      });

      it('backfills nothing when the jobs row already has title and company', async () => {
        const writes: DbWrite[] = [];
        const db = createFakeDb({
          selectResults: [
            [{ id: 'run-1' }],
            [{ task: taskRow, job: { ...jobRow, title: 'Ingest Title' } }],
          ],
          insertResults: [[]],
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
        // Both fields were ingest-recorded — no jobs write at all.
        expect(writes.some((w) => w.table === jobs)).toBe(false);
      });

      it('accepts an employmentType and stores it on the discovered jobSpec', async () => {
        const writes: DbWrite[] = [];
        const db = createFakeDb({
          selectResults: [[{ id: 'run-1' }], [joinRow]],
          insertResults: [[]],
          writes,
        });
        const { deps } = createDeps(db);
        const app = buildServer(deps);

        const res = await inject(app, {
          kind: 'form',
          result: { ...discoveredForm, employmentType: 'Intern' },
          transcript: formTranscript,
        });

        expect(res.statusCode).toBe(200);
        const taskUpdate = writes.find(
          (w) => w.method === 'update' && w.table === applicationTasks,
        );
        expect(taskUpdate?.arg).toMatchObject({
          jobSpec: { employmentType: 'Intern', discoveredByAgent: true },
        });
      });

      it('not found: records FORM_NOT_FOUND, writes no jobSpec, and marks the run not_found', async () => {
        const writes: DbWrite[] = [];
        const db = createFakeDb({
          selectResults: [[{ id: 'run-1' }], [joinRow]],
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

      it('not found: STILL backfills title/company and stores the JD markdown (the data-loss fix)', async () => {
        // The live Salesforce case: correct metadata scraped, but the apply
        // hop dead-ended on a Workday sign-in, so formFound was false — and
        // the old endpoint dropped everything.
        const markdown =
          '# Summer 2027 Intern - APM\n\nBuild product at Salesforce.';
        const writes: DbWrite[] = [];
        const db = createFakeDb({
          selectResults: [
            [{ id: 'run-1' }], // latest run
            [{ task: taskRow, job: { ...jobRow, company: null } }],
            [], // no job_descriptions rows yet
          ],
          insertResults: [[]], // FORM_NOT_FOUND event
          writes,
        });
        const { deps, enqueueProcess } = createDeps(db);
        const app = buildServer(deps);

        const res = await inject(app, {
          kind: 'form',
          result: {
            ...formNotFound,
            company: 'Salesforce',
            title: 'Summer 2027 Intern - Associate Product Manager (APM)',
            descriptionMarkdown: markdown,
          },
          transcript: formTranscript,
        });

        expect(res.statusCode).toBe(200);
        expect(enqueueProcess).not.toHaveBeenCalled();

        // Blank title AND company on the jobs row → both backfilled.
        const jobUpdate = writes.find(
          (w) => w.method === 'update' && w.table === jobs,
        );
        expect(jobUpdate?.arg).toEqual({
          company: 'Salesforce',
          title: 'Summer 2027 Intern - Associate Product Manager (APM)',
        });

        // The scraped JD lands as a versioned job_descriptions row.
        const descriptionInsert = writes.find(
          (w) => w.method === 'insert' && w.table === jobDescriptions,
        );
        expect(descriptionInsert?.arg).toMatchObject({
          jobId: 'job-u',
          version: 1,
          content: markdown,
        });

        // Still an honest not_found: no jobSpec write, FORM_NOT_FOUND event.
        expect(
          writes.some(
            (w) => w.method === 'update' && w.table === applicationTasks,
          ),
        ).toBe(false);
        const runUpdate = writes.find(
          (w) => w.method === 'update' && w.table === investigationRuns,
        );
        expect(runUpdate?.arg).toMatchObject({ status: 'not_found' });
      });

      it('not found: stores employmentType into an EXISTING jobSpec only', async () => {
        const existingSpec = {
          platform: 'unknown',
          tenant: '',
          externalId: '',
          title: 'Platform Intern',
          applyUrl: 'https://weirdats.example/jobs/1/apply',
          questions: [],
          discoveredByAgent: true,
        };
        const writes: DbWrite[] = [];
        const db = createFakeDb({
          selectResults: [
            [{ id: 'run-1' }],
            [{ task: { ...taskRow, jobSpec: existingSpec }, job: jobRow }],
          ],
          insertResults: [[]],
          writes,
        });
        const { deps } = createDeps(db);
        const app = buildServer(deps);

        const res = await inject(app, {
          kind: 'form',
          result: { ...formNotFound, employmentType: 'Intern' },
          transcript: formTranscript,
        });

        expect(res.statusCode).toBe(200);
        const taskUpdate = writes.find(
          (w) => w.method === 'update' && w.table === applicationTasks,
        );
        expect(taskUpdate?.arg).toMatchObject({
          jobSpec: { ...existingSpec, employmentType: 'Intern' },
        });
      });

      it('not found: skips employmentType when the task has no jobSpec (no minimal-spec fabrication)', async () => {
        const writes: DbWrite[] = [];
        const db = createFakeDb({
          selectResults: [[{ id: 'run-1' }], [joinRow]],
          insertResults: [[]],
          writes,
        });
        const { deps } = createDeps(db);
        const app = buildServer(deps);

        const res = await inject(app, {
          kind: 'form',
          result: { ...formNotFound, employmentType: 'Intern' },
          transcript: formTranscript,
        });

        expect(res.statusCode).toBe(200);
        expect(
          writes.some(
            (w) => w.method === 'update' && w.table === applicationTasks,
          ),
        ).toBe(false);
      });

      it('persists an explicit deadline field onto jobs.deadline (found or not)', async () => {
        const writes: DbWrite[] = [];
        const db = createFakeDb({
          selectResults: [[{ id: 'run-1' }], [joinRow]],
          insertResults: [[]],
          writes,
        });
        const { deps } = createDeps(db);
        const app = buildServer(deps);

        const res = await inject(app, {
          kind: 'form',
          result: { ...formNotFound, deadline: '2027-01-09T00:00:00.000Z' },
          transcript: formTranscript,
        });

        expect(res.statusCode).toBe(200);
        const deadlineUpdate = writes.find(
          (w) =>
            w.method === 'update' &&
            w.table === jobs &&
            (w.arg as Record<string, unknown>).deadline !== undefined,
        );
        expect(deadlineUpdate?.arg).toEqual({
          deadline: new Date('2027-01-09T00:00:00.000Z'),
        });
      });

      it('parses the deadline out of descriptionMarkdown when no field is sent', async () => {
        const writes: DbWrite[] = [];
        const db = createFakeDb({
          selectResults: [
            [{ id: 'run-1' }],
            [joinRow],
            [], // job_descriptions latest (for the JD row)
          ],
          insertResults: [[]],
          writes,
        });
        const { deps } = createDeps(db);
        const app = buildServer(deps);

        const res = await inject(app, {
          kind: 'form',
          result: {
            ...formNotFound,
            descriptionMarkdown: 'Great role. Apply by January 9, 2027.',
          },
          transcript: formTranscript,
        });

        expect(res.statusCode).toBe(200);
        const deadlineUpdate = writes.find(
          (w) =>
            w.method === 'update' &&
            w.table === jobs &&
            (w.arg as Record<string, unknown>).deadline !== undefined,
        );
        expect(deadlineUpdate?.arg).toEqual({
          deadline: new Date('2027-01-09T00:00:00.000Z'),
        });
      });

      it('never overwrites a deadline the jobs row already has', async () => {
        const writes: DbWrite[] = [];
        const db = createFakeDb({
          selectResults: [
            [{ id: 'run-1' }],
            [
              {
                task: taskRow,
                job: { ...jobRow, deadline: new Date('2026-12-01') },
              },
            ],
          ],
          insertResults: [[]],
          writes,
        });
        const { deps } = createDeps(db);
        const app = buildServer(deps);

        const res = await inject(app, {
          kind: 'form',
          result: { ...formNotFound, deadline: '2027-01-09T00:00:00.000Z' },
          transcript: formTranscript,
        });

        expect(res.statusCode).toBe(200);
        expect(writes.some((w) => w.table === jobs)).toBe(false);
      });

      it('handoffUrl: ingests it, records a HANDOFF event, and reports it in the body', async () => {
        const handoffUrl = 'https://boards.greenhouse.io/acme/jobs/999';
        const writes: DbWrite[] = [];
        const db = createFakeDb({
          selectResults: [
            [{ id: 'run-1' }], // latest run
            [joinRow], // task+job join
            [], // ingestJob canonical-url dup check: fresh
            [{ platform: 'greenhouse' }], // the ingested job's platform
          ],
          insertResults: [
            [], // FORM_NOT_FOUND event
            [{ id: 'job-9' }], // ingested job
            [{ id: 'task-9' }], // its application task
          ],
          writes,
        });
        const { deps, enqueueProcess } = createDeps(db);
        const app = buildServer(deps);

        const res = await inject(app, {
          kind: 'form',
          result: { ...formNotFound, handoffUrl },
          transcript: formTranscript,
        });

        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({
          ok: true,
          handoff: { jobId: 'job-9', taskId: 'task-9', duplicate: false },
        });

        // The handoff URL went through the real ingest pipeline + enqueued.
        const jobInsert = writes.find(
          (w) => w.method === 'insert' && w.table === jobs,
        );
        expect(jobInsert?.arg).toMatchObject({
          url: handoffUrl,
          source: 'discord-investigation',
        });
        expect(enqueueProcess).toHaveBeenCalledWith('task-9');

        // Timeline annotation on the ORIGINAL task (a plain events insert —
        // the original task keeps its state and jobSpec untouched; the task
        // updates in `writes` are the NEW task's own ingest transitions).
        const handoffEvent = writes
          .filter((w) => w.method === 'insert' && w.table === events)
          .map((w) => w.arg as Record<string, unknown>)
          .find((arg) => arg.type === 'HANDOFF');
        expect(handoffEvent).toMatchObject({
          taskId: TASK_ID,
          data: {
            handoffUrl,
            jobId: 'job-9',
            taskId: 'task-9',
            platform: 'greenhouse',
          },
        });

        // The run itself still records the honest form outcome.
        const runUpdate = writes.find(
          (w) => w.method === 'update' && w.table === investigationRuns,
        );
        expect(runUpdate?.arg).toMatchObject({
          kind: 'form',
          status: 'not_found',
          error: null,
        });
      });

      it('a duplicate handoff is reported as duplicate, with no HANDOFF event', async () => {
        const handoffUrl = 'https://boards.greenhouse.io/acme/jobs/999';
        const writes: DbWrite[] = [];
        const db = createFakeDb({
          selectResults: [
            [{ id: 'run-1' }],
            [joinRow],
            // ingestJob canonical-url dup check: already known.
            [
              {
                id: 'job-9',
                source: 'discord-ingest',
                createdAt: new Date('2026-06-01T00:00:00Z'),
              },
            ],
            [{ id: 'task-9' }], // the existing job's earliest task
            [{ platform: 'greenhouse' }],
          ],
          insertResults: [[]], // FORM_NOT_FOUND event
          writes,
        });
        const { deps, enqueueProcess } = createDeps(db);
        const app = buildServer(deps);

        const res = await inject(app, {
          kind: 'form',
          result: { ...formNotFound, handoffUrl },
          transcript: formTranscript,
        });

        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({
          ok: true,
          handoff: { jobId: 'job-9', taskId: 'task-9', duplicate: true },
        });
        expect(enqueueProcess).not.toHaveBeenCalled();
        expect(
          writes.some((w) => w.method === 'insert' && w.table === jobs),
        ).toBe(false);
        expect(
          writes
            .filter((w) => w.method === 'insert' && w.table === events)
            .map((w) => w.arg as Record<string, unknown>)
            .some((arg) => arg.type === 'HANDOFF'),
        ).toBe(false);
      });

      describe('listing expansion (not_found + listingLinks)', () => {
        it('classifies + ingests each link at child depth, records ONE LISTING_EXPANDED event, and reports counts', async () => {
          // A supported child and an unknown one — the databricks shape:
          // custom-domain greenhouse links plus the odd unclassifiable link.
          platformState.byUrl['https://gh/child1'] = {
            platform: 'greenhouse',
            tenant: 'acme',
            externalId: '77',
          };
          platformState.byUrl['https://weird/child2'] = {
            platform: 'unknown',
            tenant: null,
            externalId: null,
          };
          const writes: DbWrite[] = [];
          const db = createFakeDb({
            selectResults: [
              [{ id: 'run-1' }], // latest run
              [joinRow], // task+job join
              [], // child1 ingest dup check: fresh
              [], // child2 ingest dup check: fresh
            ],
            insertResults: [
              [], // FORM_NOT_FOUND event
              [{ id: 'job-c1' }], // child1 job
              [{ id: 'task-c1' }], // child1 task
              [], // child1 PARSE_OK event
              [], // child1 ENQUEUE event
              [{ id: 'job-c2' }], // child2 job
              [{ id: 'task-c2' }], // child2 task
              [], // child2 PARSE_OK event
              [], // child2 PARK event
              [], // LISTING_EXPANDED event
            ],
            writes,
          });
          const { deps, enqueueProcess } = createDeps(db);
          const app = buildServer(deps);

          const res = await inject(app, {
            kind: 'form',
            result: {
              ...formNotFound,
              pageKind: 'listing',
              listingLinks: ['https://gh/child1', 'https://weird/child2'],
            },
            transcript: formTranscript,
          });

          expect(res.statusCode).toBe(200);
          expect(res.json()).toEqual({
            ok: true,
            listing: {
              count: 2,
              ingested: 1,
              duplicates: 0,
              unsupported: 1,
              errors: 0,
            },
          });

          // Every child job carries the listing-expansion provenance.
          const jobInserts = writes
            .filter((w) => w.method === 'insert' && w.table === jobs)
            .map((w) => w.arg as Record<string, unknown>);
          expect(jobInserts).toHaveLength(2);
          for (const insert of jobInserts) {
            expect(insert.source).toBe('listing-expansion');
          }
          // The supported child enqueued; the unknown child parked.
          expect(enqueueProcess).toHaveBeenCalledTimes(1);
          expect(enqueueProcess).toHaveBeenCalledWith('task-c1');

          // Depth-1 no-fanout: children NEVER trigger the investigator Job
          // (a 50-link listing must not spawn 50 browser Jobs).
          expect(investigateState.calls).toEqual([]);

          // ONE LISTING_EXPANDED event on the ORIGINAL task, with the funnel.
          const listingEvents = writes
            .filter((w) => w.method === 'insert' && w.table === events)
            .map((w) => w.arg as Record<string, unknown>)
            .filter((arg) => arg.type === 'LISTING_EXPANDED');
          expect(listingEvents).toHaveLength(1);
          expect(listingEvents[0]).toEqual({
            taskId: TASK_ID,
            type: 'LISTING_EXPANDED',
            data: {
              count: 2,
              ingested: 1,
              duplicates: 0,
              unsupported: 1,
              errors: 0,
            },
          });

          // The run stays an honest not_found and the reply refreshes.
          const runUpdate = writes.find(
            (w) => w.method === 'update' && w.table === investigationRuns,
          );
          expect(runUpdate?.arg).toMatchObject({
            kind: 'form',
            status: 'not_found',
            error: null,
          });
          expect(refreshState.calls).toEqual([TASK_ID]);
        });

        it('counts an already-known link as a duplicate (nothing re-ingested)', async () => {
          platformState.byUrl['https://gh/dup'] = {
            platform: 'greenhouse',
            tenant: 'acme',
            externalId: '88',
          };
          const writes: DbWrite[] = [];
          const db = createFakeDb({
            selectResults: [
              [{ id: 'run-1' }],
              [joinRow],
              // dup check: already ingested
              [
                {
                  id: 'job-dup',
                  source: 'discord',
                  createdAt: new Date('2026-07-01T00:00:00Z'),
                },
              ],
              [{ id: 'task-orig' }], // the existing job's earliest task
            ],
            insertResults: [[]], // FORM_NOT_FOUND event
            writes,
          });
          const { deps, enqueueProcess } = createDeps(db);
          const app = buildServer(deps);

          const res = await inject(app, {
            kind: 'form',
            result: {
              ...formNotFound,
              pageKind: 'listing',
              listingLinks: ['https://gh/dup'],
            },
            transcript: formTranscript,
          });

          expect(res.statusCode).toBe(200);
          expect(res.json()).toEqual({
            ok: true,
            listing: {
              count: 1,
              ingested: 0,
              duplicates: 1,
              unsupported: 0,
              errors: 0,
            },
          });
          expect(enqueueProcess).not.toHaveBeenCalled();
          expect(
            writes.some((w) => w.method === 'insert' && w.table === jobs),
          ).toBe(false);
          const listingEvent = writes
            .filter((w) => w.method === 'insert' && w.table === events)
            .map((w) => w.arg as Record<string, unknown>)
            .find((arg) => arg.type === 'LISTING_EXPANDED');
          expect(listingEvent?.data).toEqual({
            count: 1,
            ingested: 0,
            duplicates: 1,
            unsupported: 0,
            errors: 0,
          });
        });

        it('never expands on a formFound result even when listingLinks are present', async () => {
          const writes: DbWrite[] = [];
          const db = createFakeDb({
            selectResults: [[{ id: 'run-1' }], [joinRow]],
            insertResults: [[]], // FORM_DISCOVERED event
            writes,
          });
          const { deps, enqueueProcess } = createDeps(db);
          const app = buildServer(deps);

          const res = await inject(app, {
            kind: 'form',
            result: {
              ...discoveredForm,
              listingLinks: ['https://gh/child1', 'https://gh/child2'],
            },
            transcript: formTranscript,
          });

          expect(res.statusCode).toBe(200);
          expect(res.json()).toEqual({ ok: true });
          expect(enqueueProcess).not.toHaveBeenCalled();
          expect(
            writes.some((w) => w.method === 'insert' && w.table === jobs),
          ).toBe(false);
          expect(
            writes
              .filter((w) => w.method === 'insert' && w.table === events)
              .map((w) => w.arg as Record<string, unknown>)
              .some((arg) => arg.type === 'LISTING_EXPANDED'),
          ).toBe(false);
        });

        it('rejects more than 50 listingLinks and over-long urls (400)', async () => {
          const { deps } = createDeps(createFakeDb());
          const app = buildServer(deps);
          for (const listingLinks of [
            Array.from({ length: 51 }, (_, i) => `https://jobs.example/${i}`),
            [`https://jobs.example/${'x'.repeat(2000)}`],
          ]) {
            const res = await inject(app, {
              kind: 'form',
              result: { ...formNotFound, listingLinks },
              transcript: [],
            });
            expect(res.statusCode).toBe(400);
            expect(res.json()).toMatchObject({ error: 'invalid body' });
          }
        });
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

  describe('POST /alerts/deadlines', () => {
    it('responds 401 without an api key (guarded like every route)', async () => {
      const { deps } = createDeps(createFakeDb());
      const app = buildServer(deps);
      const res = await app.inject({
        method: 'POST',
        url: '/alerts/deadlines',
      });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: 'unauthorized' });
    });

    it('no-ops {enabled:false} until Discord + the alerts channel are configured', async () => {
      const { deps } = createDeps(createFakeDb());
      const app = buildServer(deps);
      const res = await app.inject({
        method: 'POST',
        url: '/alerts/deadlines',
        headers: { 'x-api-key': 'test-key' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        enabled: false,
        due: 0,
        alerted: 0,
        skipped: 0,
      });
    });

    it('alerts a due-today task when configured and records the DEADLINE_ALERT event', async () => {
      const writes: DbWrite[] = [];
      const db = createFakeDb({
        selectResults: [
          [
            {
              taskId: '7d8e9f10-1112-4314-a516-b71819c2d2e2',
              state: 'NEEDS_INPUT',
              // "now" always falls on today's ET date, whatever the clock.
              dueDate: new Date(),
              deadline: null,
              company: 'Acme',
              title: 'SWE Intern',
              url: 'https://job.example/x',
            },
          ],
          [], // no prior DEADLINE_ALERT events
        ],
        writes,
      });
      const { deps } = createDeps(db);
      deps.config = {
        ...config,
        DISCORD_BOT_TOKEN: 'token',
        DISCORD_ENABLED: true,
        DISCORD_ALERTS_CHANNEL_ID: 'chan-alerts',
      };
      const postChannelMessage = vi.fn(async () => ({ id: 'm1' }));
      deps.notify = { postChannelMessage } as unknown as NonNullable<
        Deps['notify']
      >;
      const app = buildServer(deps);

      const res = await app.inject({
        method: 'POST',
        url: '/alerts/deadlines',
        headers: { 'x-api-key': 'test-key' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        enabled: true,
        due: 1,
        alerted: 1,
        skipped: 0,
      });
      expect(postChannelMessage).toHaveBeenCalledTimes(1);
      const alertEvent = writes
        .filter((w) => w.method === 'insert' && w.table === events)
        .map((w) => w.arg as Record<string, unknown>)
        .find((arg) => arg.type === 'DEADLINE_ALERT');
      expect(alertEvent).toMatchObject({
        taskId: '7d8e9f10-1112-4314-a516-b71819c2d2e2',
        data: { channel: 'discord' },
      });
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

    it('stores a trimmed note in the DISCARD event data when one is sent', async () => {
      const writes: DbWrite[] = [];
      const db = createFakeDb({
        selectResults: [[{ state: 'NEEDS_INPUT' }]],
        insertResults: [[]], // DISCARD event
        writes,
      });
      const { deps } = createDeps(db);
      const app = buildServer(deps);

      const res = await app.inject({
        method: 'POST',
        url: `/tasks/${TASK_ID}/discard`,
        headers: { 'x-api-key': 'test-key' },
        payload: { note: '  role is on-site only  ' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
      const discardEvent = writes
        .filter((w) => w.method === 'insert' && w.table === events)
        .map((w) => w.arg as Record<string, unknown>)
        .find((arg) => arg.type === 'DISCARD');
      expect(discardEvent?.data).toEqual({
        reason: 'manual',
        note: 'role is on-site only',
      });
    });

    it('treats a whitespace-only note as absent (no note key in the event)', async () => {
      const writes: DbWrite[] = [];
      const db = createFakeDb({
        selectResults: [[{ state: 'NEEDS_INPUT' }]],
        insertResults: [[]], // DISCARD event
        writes,
      });
      const { deps } = createDeps(db);
      const app = buildServer(deps);

      const res = await app.inject({
        method: 'POST',
        url: `/tasks/${TASK_ID}/discard`,
        headers: { 'x-api-key': 'test-key' },
        payload: { note: '   ' },
      });

      expect(res.statusCode).toBe(200);
      const discardEvent = writes
        .filter((w) => w.method === 'insert' && w.table === events)
        .map((w) => w.arg as Record<string, unknown>)
        .find((arg) => arg.type === 'DISCARD');
      expect(discardEvent?.data).toEqual({ reason: 'manual' });
    });

    it('rejects an over-long note (400, nothing written)', async () => {
      const writes: DbWrite[] = [];
      const db = createFakeDb({
        selectResults: [[{ state: 'NEEDS_INPUT' }]],
        writes,
      });
      const { deps } = createDeps(db);
      const app = buildServer(deps);

      const res = await app.inject({
        method: 'POST',
        url: `/tasks/${TASK_ID}/discard`,
        headers: { 'x-api-key': 'test-key' },
        payload: { note: 'x'.repeat(2001) },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: 'invalid body' });
      expect(writes).toEqual([]);
      expect(refreshState.calls).toEqual([]);
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

  describe('POST /tasks/:id/restore', () => {
    const TASK_ID = '7d8e9f10-1112-4314-a516-b71819c2d2e2';

    function inject(app: ReturnType<typeof buildServer>, id: string = TASK_ID) {
      return app.inject({
        method: 'POST',
        url: `/tasks/${id}/restore`,
        headers: { 'x-api-key': 'test-key' },
      });
    }

    it('restores a DISCARDED task to NEEDS_INPUT with a RESTORE event + refresh', async () => {
      const writes: DbWrite[] = [];
      const db = createFakeDb({
        selectResults: [[{ state: 'DISCARDED' }]],
        insertResults: [[]], // RESTORE event
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
      expect(taskUpdate?.arg).toMatchObject({ state: 'NEEDS_INPUT' });

      const restoreEvent = writes
        .filter((w) => w.method === 'insert' && w.table === events)
        .map((w) => w.arg as Record<string, unknown>)
        .find((arg) => arg.type === 'RESTORE');
      expect(restoreEvent).toMatchObject({
        taskId: TASK_ID,
        fromState: 'DISCARDED',
        toState: 'NEEDS_INPUT',
        data: { reason: 'manual' },
      });
      expect(refreshState.calls).toEqual([TASK_ID]);
    });

    it('double-clicked undo is safe: NEEDS_INPUT is a 200 no-op', async () => {
      const writes: DbWrite[] = [];
      const db = createFakeDb({
        selectResults: [[{ state: 'NEEDS_INPUT' }]],
        writes,
      });
      const { deps } = createDeps(db);
      const app = buildServer(deps);

      const res = await inject(app);

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
      expect(writes).toEqual([]);
    });

    it('responds 409 for a task that is neither DISCARDED nor NEEDS_INPUT', async () => {
      for (const state of ['QUEUED', 'SUBMITTED']) {
        const writes: DbWrite[] = [];
        const db = createFakeDb({ selectResults: [[{ state }]], writes });
        const { deps } = createDeps(db);
        const app = buildServer(deps);

        const res = await inject(app);

        expect(res.statusCode).toBe(409);
        expect(res.json()).toEqual({
          error: `cannot restore a task in state '${state}'`,
        });
        expect(writes).toEqual([]);
      }
    });

    it('responds 404 for a missing task, 400 for an invalid id, 401 without a key', async () => {
      const { deps } = createDeps(createFakeDb({ selectResults: [[]] }));
      const app = buildServer(deps);

      const missing = await inject(app);
      expect(missing.statusCode).toBe(404);

      const invalid = await inject(app, 'not-a-uuid');
      expect(invalid.statusCode).toBe(400);

      const unauthed = await app.inject({
        method: 'POST',
        url: `/tasks/${TASK_ID}/restore`,
      });
      expect(unauthed.statusCode).toBe(401);
    });
  });

  describe('POST /tasks/:id/mark-applied', () => {
    const TASK_ID = '7d8e9f10-1112-4314-a516-b71819c2d2e2';

    function inject(
      app: ReturnType<typeof buildServer>,
      id: string = TASK_ID,
      payload?: Record<string, unknown>,
    ) {
      return app.inject({
        method: 'POST',
        url: `/tasks/${id}/mark-applied`,
        headers: { 'x-api-key': 'test-key' },
        ...(payload !== undefined ? { payload } : {}),
      });
    }

    it('marks an active task applied: MARK_SUBMITTED transition + event, then refreshes the reply', async () => {
      const writes: DbWrite[] = [];
      const db = createFakeDb({
        selectResults: [[{ state: 'NEEDS_INPUT' }]],
        insertResults: [[]], // MARK_SUBMITTED event
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
      expect(taskUpdate?.arg).toMatchObject({ state: 'SUBMITTED' });

      const markEvent = writes
        .filter((w) => w.method === 'insert' && w.table === events)
        .map((w) => w.arg as Record<string, unknown>)
        .find((arg) => arg.type === 'MARK_SUBMITTED');
      expect(markEvent).toMatchObject({
        taskId: TASK_ID,
        fromState: 'NEEDS_INPUT',
        toState: 'SUBMITTED',
        data: { reason: 'manual' },
      });

      // The #ingest reply line flips to "applied".
      expect(refreshState.calls).toEqual([TASK_ID]);
    });

    it('stores a trimmed note ("where/how") in the MARK_SUBMITTED event data', async () => {
      const writes: DbWrite[] = [];
      const db = createFakeDb({
        selectResults: [[{ state: 'REVIEW' }]],
        insertResults: [[]], // MARK_SUBMITTED event
        writes,
      });
      const { deps } = createDeps(db);
      const app = buildServer(deps);

      const res = await inject(app, TASK_ID, {
        note: '  applied via their careers portal  ',
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
      const markEvent = writes
        .filter((w) => w.method === 'insert' && w.table === events)
        .map((w) => w.arg as Record<string, unknown>)
        .find((arg) => arg.type === 'MARK_SUBMITTED');
      expect(markEvent?.data).toEqual({
        reason: 'manual',
        note: 'applied via their careers portal',
      });
    });

    it('treats a whitespace-only note as absent (no note key in the event)', async () => {
      const writes: DbWrite[] = [];
      const db = createFakeDb({
        selectResults: [[{ state: 'QUEUED' }]],
        insertResults: [[]], // MARK_SUBMITTED event
        writes,
      });
      const { deps } = createDeps(db);
      const app = buildServer(deps);

      const res = await inject(app, TASK_ID, { note: '   ' });

      expect(res.statusCode).toBe(200);
      const markEvent = writes
        .filter((w) => w.method === 'insert' && w.table === events)
        .map((w) => w.arg as Record<string, unknown>)
        .find((arg) => arg.type === 'MARK_SUBMITTED');
      expect(markEvent?.data).toEqual({ reason: 'manual' });
    });

    it('rejects an over-long note (400, nothing written)', async () => {
      const writes: DbWrite[] = [];
      const db = createFakeDb({
        selectResults: [[{ state: 'NEEDS_INPUT' }]],
        writes,
      });
      const { deps } = createDeps(db);
      const app = buildServer(deps);

      const res = await inject(app, TASK_ID, { note: 'x'.repeat(2001) });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: 'invalid body' });
      expect(writes).toEqual([]);
      expect(refreshState.calls).toEqual([]);
    });

    it('is idempotent: an already-sent task (SUBMITTED/CONFIRMED) is a 200 no-op', async () => {
      for (const state of ['SUBMITTED', 'CONFIRMED']) {
        const writes: DbWrite[] = [];
        const db = createFakeDb({ selectResults: [[{ state }]], writes });
        const { deps } = createDeps(db);
        const app = buildServer(deps);

        const res = await inject(app);

        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ ok: true });
        expect(writes).toEqual([]);
      }
      expect(refreshState.calls).toEqual([]);
    });

    it('responds 409 for an archived task (DISCARDED/DUPLICATE)', async () => {
      for (const state of ['DISCARDED', 'DUPLICATE']) {
        const writes: DbWrite[] = [];
        const db = createFakeDb({ selectResults: [[{ state }]], writes });
        const { deps } = createDeps(db);
        const app = buildServer(deps);

        const res = await inject(app);

        expect(res.statusCode).toBe(409);
        expect(res.json()).toEqual({
          error: `cannot mark a task applied in state '${state}'`,
        });
        expect(writes).toEqual([]);
      }
      expect(refreshState.calls).toEqual([]);
    });

    it('responds 404 for a missing task, 400 for an invalid id, 401 without a key', async () => {
      const { deps } = createDeps(createFakeDb({ selectResults: [[]] }));
      const app = buildServer(deps);

      const missing = await inject(app);
      expect(missing.statusCode).toBe(404);
      expect(missing.json()).toEqual({ error: 'task not found' });

      const invalid = await inject(app, 'not-a-uuid');
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json()).toMatchObject({ error: 'invalid task id' });

      const unauthed = await app.inject({
        method: 'POST',
        url: `/tasks/${TASK_ID}/mark-applied`,
      });
      expect(unauthed.statusCode).toBe(401);
    });
  });

  describe('POST /tasks/:id/unmark-applied', () => {
    const TASK_ID = '7d8e9f10-1112-4314-a516-b71819c2d2e2';

    function inject(app: ReturnType<typeof buildServer>, id: string = TASK_ID) {
      return app.inject({
        method: 'POST',
        url: `/tasks/${id}/unmark-applied`,
        headers: { 'x-api-key': 'test-key' },
      });
    }

    it('un-marks an out-of-band SUBMITTED task: UNMARK_SUBMITTED back to NEEDS_INPUT + refresh', async () => {
      const writes: DbWrite[] = [];
      const db = createFakeDb({
        selectResults: [
          [{ state: 'SUBMITTED' }],
          // Latest SUBMITTED-entering event: the out-of-band mark.
          [{ type: 'MARK_SUBMITTED' }],
        ],
        insertResults: [[]], // UNMARK_SUBMITTED event
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
      expect(taskUpdate?.arg).toMatchObject({ state: 'NEEDS_INPUT' });

      const unmarkEvent = writes
        .filter((w) => w.method === 'insert' && w.table === events)
        .map((w) => w.arg as Record<string, unknown>)
        .find((arg) => arg.type === 'UNMARK_SUBMITTED');
      expect(unmarkEvent).toMatchObject({
        taskId: TASK_ID,
        fromState: 'SUBMITTED',
        toState: 'NEEDS_INPUT',
        data: { reason: 'manual' },
      });

      // The #ingest reply line leaves "applied".
      expect(refreshState.calls).toEqual([TASK_ID]);
    });

    it('responds 409 when sower itself submitted (latest SUBMITTED-entering event is SUBMIT_OK)', async () => {
      const writes: DbWrite[] = [];
      const db = createFakeDb({
        selectResults: [[{ state: 'SUBMITTED' }], [{ type: 'SUBMIT_OK' }]],
        writes,
      });
      const { deps } = createDeps(db);
      const app = buildServer(deps);

      const res = await inject(app);

      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({
        error:
          "this application was submitted by sower — it can't be un-marked",
      });
      expect(writes).toEqual([]);
      expect(refreshState.calls).toEqual([]);
    });

    it('responds 409 when no SUBMITTED-entering event is recorded (nothing to prove out-of-band)', async () => {
      const writes: DbWrite[] = [];
      const db = createFakeDb({
        selectResults: [[{ state: 'SUBMITTED' }], []],
        writes,
      });
      const { deps } = createDeps(db);
      const app = buildServer(deps);

      const res = await inject(app);

      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({
        error:
          "this application was submitted by sower — it can't be un-marked",
      });
      expect(writes).toEqual([]);
    });

    it('responds 409 for any non-SUBMITTED state (CONFIRMED, NEEDS_INPUT, DISCARDED)', async () => {
      for (const state of ['CONFIRMED', 'NEEDS_INPUT', 'DISCARDED']) {
        const writes: DbWrite[] = [];
        const db = createFakeDb({ selectResults: [[{ state }]], writes });
        const { deps } = createDeps(db);
        const app = buildServer(deps);

        const res = await inject(app);

        expect(res.statusCode).toBe(409);
        expect(res.json()).toEqual({
          error: `cannot un-mark a task in state '${state}'`,
        });
        expect(writes).toEqual([]);
      }
      expect(refreshState.calls).toEqual([]);
    });

    it('responds 404 for a missing task, 400 for an invalid id, 401 without a key', async () => {
      const { deps } = createDeps(createFakeDb({ selectResults: [[]] }));
      const app = buildServer(deps);

      const missing = await inject(app);
      expect(missing.statusCode).toBe(404);
      expect(missing.json()).toEqual({ error: 'task not found' });

      const invalid = await inject(app, 'not-a-uuid');
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json()).toMatchObject({ error: 'invalid task id' });

      const unauthed = await app.inject({
        method: 'POST',
        url: `/tasks/${TASK_ID}/unmark-applied`,
      });
      expect(unauthed.statusCode).toBe(401);
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

    it('stores the optional bulk note on every DISCARD event (H5)', async () => {
      const writes: DbWrite[] = [];
      const db = createFakeDb({
        selectResults: [[{ state: 'QUEUED' }], [{ state: 'NEEDS_INPUT' }]],
        insertResults: [[], []],
        writes,
      });
      const { deps } = createDeps(db);
      const app = buildServer(deps);

      const res = await inject(app, {
        taskIds: [ID_A, ID_B],
        note: 'no sponsorship',
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ ok: true, discarded: 2 });
      const discardEvents = writes
        .filter((w) => w.method === 'insert' && w.table === events)
        .map((w) => w.arg as Record<string, unknown>)
        .filter((arg) => arg.type === 'DISCARD');
      expect(discardEvents).toHaveLength(2);
      for (const event of discardEvents) {
        expect(event.data).toMatchObject({
          reason: 'manual',
          note: 'no sponsorship',
        });
      }
    });

    it('a blank bulk note is omitted from the event data entirely', async () => {
      const writes: DbWrite[] = [];
      const db = createFakeDb({
        selectResults: [[{ state: 'QUEUED' }]],
        insertResults: [[]],
        writes,
      });
      const { deps } = createDeps(db);
      const app = buildServer(deps);

      const res = await inject(app, { taskIds: [ID_A], note: '   ' });

      expect(res.statusCode).toBe(200);
      const discardEvent = writes
        .filter((w) => w.method === 'insert' && w.table === events)
        .map((w) => w.arg as Record<string, unknown>)
        .find((arg) => arg.type === 'DISCARD');
      expect(discardEvent?.data).toEqual({ reason: 'manual' });
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

  describe('POST /tasks/:id/meta', () => {
    const TASK_ID = '7d8e9f10-1112-4314-a516-b71819c2d2e2';

    function inject(
      app: ReturnType<typeof buildServer>,
      payload: unknown,
      id: string = TASK_ID,
    ) {
      return app.inject({
        method: 'POST',
        url: `/tasks/${id}/meta`,
        headers: { 'x-api-key': 'test-key' },
        payload: payload as Record<string, unknown>,
      });
    }

    /** Fake db whose first select finds the task; writes are recorded.
     *  `priority` is the row's CURRENT priority — the handler compares it
     *  against the body to decide whether a priority write is an actual
     *  change (which clears the manual rank) or a same-value settle. */
    function metaDb(writes: DbWrite[], priority = 0) {
      return createFakeDb({
        selectResults: [[{ id: TASK_ID, priority }]],
        writes,
      });
    }

    it('updates notes only (priority untouched)', async () => {
      const writes: DbWrite[] = [];
      const { deps } = createDeps(metaDb(writes));
      const app = buildServer(deps);

      const res = await inject(app, { notes: 'ping recruiter on Friday' });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
      const update = writes.find(
        (w) => w.method === 'update' && w.table === applicationTasks,
      );
      const set = update?.arg as Record<string, unknown>;
      expect(set.notes).toBe('ping recruiter on Friday');
      // Annotations are not activity: updatedAt is never touched, so the
      // dashboard's recency-ordered lists don't re-sort under a note edit.
      expect('updatedAt' in set).toBe(false);
      // PATCH semantics: an omitted field is never written.
      expect('priority' in set).toBe(false);
      expect('state' in set).toBe(false);
    });

    it('updates priority only (notes untouched)', async () => {
      const writes: DbWrite[] = [];
      const { deps } = createDeps(metaDb(writes));
      const app = buildServer(deps);

      const res = await inject(app, { priority: 1 });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
      const set = writes.find((w) => w.method === 'update')?.arg as Record<
        string,
        unknown
      >;
      expect(set.priority).toBe(1);
      expect('notes' in set).toBe(false);
    });

    it('updates both fields in one write', async () => {
      const writes: DbWrite[] = [];
      const { deps } = createDeps(metaDb(writes));
      const app = buildServer(deps);

      const res = await inject(app, { notes: 'top choice', priority: -1 });

      expect(res.statusCode).toBe(200);
      const updates = writes.filter((w) => w.method === 'update');
      expect(updates).toHaveLength(1);
      expect(updates[0]?.arg).toMatchObject({
        notes: 'top choice',
        priority: -1,
      });
    });

    it('notes: null clears the note', async () => {
      const writes: DbWrite[] = [];
      const { deps } = createDeps(metaDb(writes));
      const app = buildServer(deps);

      const res = await inject(app, { notes: null });

      expect(res.statusCode).toBe(200);
      const set = writes.find((w) => w.method === 'update')?.arg as Record<
        string,
        unknown
      >;
      expect(set.notes).toBeNull();
    });

    it('accepts the Highest priority (2, above High)', async () => {
      const writes: DbWrite[] = [];
      const { deps } = createDeps(metaDb(writes));
      const app = buildServer(deps);

      const res = await inject(app, { priority: 2 });

      expect(res.statusCode).toBe(200);
      const set = writes.find((w) => w.method === 'update')?.arg as Record<
        string,
        unknown
      >;
      expect(set.priority).toBe(2);
    });

    // Rank is only meaningful WITHIN a priority tier: an explicit priority
    // change clears the manual rank — the row re-enters its new tier as its
    // newest unranked (top-of-tier) item, and can never demote below it.
    it('STEPPER PRIORITY CHANGE CLEARS THE RANK: priority and the null rank land in ONE atomic update', async () => {
      const writes: DbWrite[] = [];
      const { deps } = createDeps(metaDb(writes));
      const app = buildServer(deps);

      const res = await inject(app, { priority: 2 });

      expect(res.statusCode).toBe(200);
      const updates = writes.filter((w) => w.method === 'update');
      expect(updates).toHaveLength(1);
      // One UPDATE carries both: no window where the row keeps a rank into
      // a tier it just left (and no read of the old rank to race with a
      // concurrent reorder — null simply wins).
      expect(updates[0]?.arg).toEqual({ priority: 2, sortRank: null });
    });

    it('a same-value priority write (the stepper settling where it started) leaves the rank alone', async () => {
      const writes: DbWrite[] = [];
      // Row already at High; the debounced absolute write repeats it.
      const { deps } = createDeps(metaDb(writes, 1));
      const app = buildServer(deps);

      const res = await inject(app, { priority: 1 });

      expect(res.statusCode).toBe(200);
      const set = writes.find((w) => w.method === 'update')?.arg as Record<
        string,
        unknown
      >;
      // An up-then-down toggle nets to no change — it must not destroy a
      // hand-made rank as a side effect.
      expect(set.priority).toBe(1);
      expect('sortRank' in set).toBe(false);
    });

    it('lowering priority clears the rank too (the row heads its NEW tier, never sinks below it)', async () => {
      const writes: DbWrite[] = [];
      const { deps } = createDeps(metaDb(writes, 2));
      const app = buildServer(deps);

      const res = await inject(app, { priority: -1 });

      expect(res.statusCode).toBe(200);
      const updates = writes.filter((w) => w.method === 'update');
      expect(updates).toHaveLength(1);
      expect(updates[0]?.arg).toEqual({ priority: -1, sortRank: null });
    });

    it('a notes-only update leaves an existing sort rank alone', async () => {
      const writes: DbWrite[] = [];
      const { deps } = createDeps(metaDb(writes));
      const app = buildServer(deps);

      const res = await inject(app, { notes: 'still hand-ordered' });

      expect(res.statusCode).toBe(200);
      const set = writes.find((w) => w.method === 'update')?.arg as Record<
        string,
        unknown
      >;
      expect('sortRank' in set).toBe(false);
    });

    it('sets the user due date (normalized to ET midnight) without touching updatedAt', async () => {
      const writes: DbWrite[] = [];
      const { deps } = createDeps(metaDb(writes));
      const app = buildServer(deps);

      const res = await inject(app, { dueDate: '2026-08-01' });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
      const set = writes.find((w) => w.method === 'update')?.arg as Record<
        string,
        unknown
      >;
      expect(set.dueDate).toBeInstanceOf(Date);
      // Date-only due dates normalize to ET midnight (EDT: 04:00Z) so the
      // midnight-ET alert fires on the calendar day the user meant.
      expect((set.dueDate as Date).toISOString()).toBe(
        '2026-08-01T04:00:00.000Z',
      );
      // Like notes: a due date is an annotation, never activity.
      expect('updatedAt' in set).toBe(false);
      expect('notes' in set).toBe(false);
      expect('priority' in set).toBe(false);
    });

    it('dueDate: null clears the user due date', async () => {
      const writes: DbWrite[] = [];
      const { deps } = createDeps(metaDb(writes));
      const app = buildServer(deps);

      const res = await inject(app, { dueDate: null });

      expect(res.statusCode).toBe(200);
      const set = writes.find((w) => w.method === 'update')?.arg as Record<
        string,
        unknown
      >;
      expect(set.dueDate).toBeNull();
    });

    it('responds 400 for an unparseable dueDate (nothing written)', async () => {
      for (const dueDate of ['not-a-date', '2026-13-45garbage', '']) {
        const writes: DbWrite[] = [];
        const { deps } = createDeps(metaDb(writes));
        const app = buildServer(deps);

        const res = await inject(app, { dueDate });

        expect(res.statusCode).toBe(400);
        expect(res.json()).toMatchObject({ error: 'invalid body' });
        expect(writes).toEqual([]);
      }
    });

    it('responds 400 for an invalid priority (nothing written)', async () => {
      for (const priority of [3, -2, 0.5, 'high']) {
        const writes: DbWrite[] = [];
        const { deps } = createDeps(metaDb(writes));
        const app = buildServer(deps);

        const res = await inject(app, { priority });

        expect(res.statusCode).toBe(400);
        expect(res.json()).toMatchObject({ error: 'invalid body' });
        expect(writes).toEqual([]);
      }
    });

    it('responds 400 for an empty body (at least one field required)', async () => {
      const writes: DbWrite[] = [];
      const { deps } = createDeps(metaDb(writes));
      const app = buildServer(deps);

      const res = await inject(app, {});

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: 'invalid body' });
      expect(writes).toEqual([]);
    });

    it('responds 400 for notes above the 20k cap', async () => {
      const writes: DbWrite[] = [];
      const { deps } = createDeps(metaDb(writes));
      const app = buildServer(deps);

      const res = await inject(app, { notes: 'x'.repeat(20_001) });

      expect(res.statusCode).toBe(400);
      expect(writes).toEqual([]);
    });

    it('responds 404 for a missing task and 400 for an invalid id', async () => {
      const { deps } = createDeps(createFakeDb({ selectResults: [[]] }));
      const app = buildServer(deps);

      const missing = await inject(app, { priority: 0 });
      expect(missing.statusCode).toBe(404);
      expect(missing.json()).toEqual({ error: 'task not found' });

      const invalid = await inject(app, { priority: 0 }, 'not-a-uuid');
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json()).toMatchObject({ error: 'invalid task id' });
    });

    it('responds 401 without an api key (guarded like every route)', async () => {
      const { deps } = createDeps(createFakeDb());
      const app = buildServer(deps);
      const res = await app.inject({
        method: 'POST',
        url: `/tasks/${TASK_ID}/meta`,
        payload: { priority: 1 },
      });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('POST /tasks/:id/reorder', () => {
    const TASK_ID = '7d8e9f10-1112-4314-a516-b71819c2d2e2';
    const ID_A = 'a1b2c3d4-e5f6-4788-99aa-bbccddeeff00';
    const ID_B = '00112233-4455-4677-8899-aabbccddeeff';
    const ID_C = '99887766-5544-4332-a110-ffeeddccbbaa';

    function inject(
      app: ReturnType<typeof buildServer>,
      payload: unknown,
      id: string = TASK_ID,
    ) {
      return app.inject({
        method: 'POST',
        url: `/tasks/${id}/reorder`,
        headers: { 'x-api-key': 'test-key' },
        payload: payload as Record<string, unknown>,
      });
    }

    /** Fake db: first select = the task row (state + current priority),
     *  second = the section in its current display order (priority desc;
     *  within a tier unranked-by-arrival first, then ranked). Section rows
     *  default to priority 0 — the single-tier case. */
    function reorderDb(
      writes: DbWrite[],
      section: { id: string; sortRank: number | null; priority?: number }[],
      options: { state?: string; priority?: number } = {},
    ) {
      return createFakeDb({
        selectResults: [
          [
            {
              state: options.state ?? 'NEEDS_INPUT',
              priority: options.priority ?? 0,
            },
          ],
          section.map((r) => ({ priority: 0, ...r })),
        ],
        writes,
      });
    }

    /** The sortRank values of every recorded update, in write order. */
    function rankWrites(writes: DbWrite[]): unknown[] {
      return writes
        .filter((w) => w.method === 'update' && w.table === applicationTasks)
        .map((w) => (w.arg as Record<string, unknown>).sortRank);
    }

    it('drops between two ranked neighbors at their midpoint', async () => {
      const writes: DbWrite[] = [];
      const db = reorderDb(writes, [
        { id: ID_A, sortRank: 1024 },
        { id: ID_B, sortRank: 2048 },
        { id: TASK_ID, sortRank: null },
      ]);
      const { deps } = createDeps(db);
      const app = buildServer(deps);

      const res = await inject(app, { beforeTaskId: ID_A, afterTaskId: ID_B });

      expect(res.statusCode).toBe(200);
      // No {priority} in the response: a within-tier drop never changes it.
      expect(res.json()).toEqual({ ok: true, sortRank: 1536 });
      // Exactly one write: the moved task; the ranked neighbors are reused —
      // and the write carries no priority key (nothing to adopt).
      const updates = writes.filter((w) => w.method === 'update');
      expect(updates).toHaveLength(1);
      expect(updates[0]?.arg).toEqual({ sortRank: 1536 });
    });

    it('drops at the bottom end: beforeTaskId only, rank + 1024', async () => {
      const writes: DbWrite[] = [];
      const db = reorderDb(writes, [
        { id: ID_A, sortRank: 1024 },
        { id: ID_B, sortRank: 2048 },
        { id: TASK_ID, sortRank: null },
      ]);
      const { deps } = createDeps(db);
      const app = buildServer(deps);

      const res = await inject(app, { beforeTaskId: ID_B });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, sortRank: 3072 });
      expect(rankWrites(writes)).toEqual([3072]);
    });

    it('drops at the top end: afterTaskId only, rank - 1024', async () => {
      const writes: DbWrite[] = [];
      const db = reorderDb(writes, [
        { id: ID_A, sortRank: 1024 },
        { id: TASK_ID, sortRank: null },
      ]);
      const { deps } = createDeps(db);
      const app = buildServer(deps);

      const res = await inject(app, { afterTaskId: ID_A });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, sortRank: 0 });
      expect(rankWrites(writes)).toEqual([0]);
    });

    it('assigns ranks lazily when a neighbor is unranked: the tier is resequenced first', async () => {
      const writes: DbWrite[] = [];
      // B and C exist only via the arrival sort (unranked, so they display
      // FIRST in the tier); A is ranked below them. All one tier: the whole
      // tier gets RANK_GAP-spaced integers in its current display order —
      // which hand-places the unranked block, so the drop lands exactly
      // where the user put it.
      const db = reorderDb(writes, [
        { id: ID_B, sortRank: null },
        { id: ID_C, sortRank: null },
        { id: TASK_ID, sortRank: null },
        { id: ID_A, sortRank: 1024 },
      ]);
      const { deps } = createDeps(db);
      const app = buildServer(deps);

      // Drop the task between the two unranked rows.
      const res = await inject(app, { beforeTaskId: ID_B, afterTaskId: ID_C });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, sortRank: 1536 });
      // Resequence writes 1024-spaced integers in the current visual order
      // (B 1024, C 2048, A 3072 — every value changed), then the midpoint.
      expect(rankWrites(writes)).toEqual([1024, 2048, 3072, 1536]);
    });

    it('resequences when the neighbors are too close for a distinct midpoint', async () => {
      const writes: DbWrite[] = [];
      const db = reorderDb(writes, [
        { id: ID_A, sortRank: 1000 },
        { id: ID_B, sortRank: 1000 + 1e-9 },
        { id: TASK_ID, sortRank: null },
      ]);
      const { deps } = createDeps(db);
      const app = buildServer(deps);

      const res = await inject(app, { beforeTaskId: ID_A, afterTaskId: ID_B });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, sortRank: 1536 });
      expect(rankWrites(writes)).toEqual([1024, 2048, 1536]);
    });

    it('CROSS-TIER DROP at a boundary: adopts the tier of the row it was dropped directly below — priority + rank in ONE atomic update, {priority} in the response', async () => {
      const writes: DbWrite[] = [];
      // Display: A (High, ranked, last row of its tier) then B (Normal,
      // unranked). The Normal task is dropped into the boundary gap.
      const db = reorderDb(writes, [
        { id: ID_A, sortRank: 1024, priority: 1 },
        { id: ID_B, sortRank: null, priority: 0 },
        { id: TASK_ID, sortRank: null, priority: 0 },
      ]);
      const { deps } = createDeps(db);
      const app = buildServer(deps);

      const res = await inject(app, { beforeTaskId: ID_A, afterTaskId: ID_B });

      expect(res.statusCode).toBe(200);
      // The row was dropped directly below A → it joins A's tier (High) at
      // the tier's bottom (A.rank + RANK_GAP). B, across the boundary,
      // contributes no rank — and its unranked-ness triggers NO resequence.
      expect(res.json()).toEqual({ ok: true, sortRank: 2048, priority: 1 });
      const updates = writes.filter((w) => w.method === 'update');
      expect(updates).toHaveLength(1);
      // ONE UPDATE carries both keys: no window where the row is ranked
      // into a tier it isn't in.
      expect(updates[0]?.arg).toEqual({ sortRank: 2048, priority: 1 });
    });

    it('a drop at the very top of the list adopts the tier it now heads (ranking that tier lazily)', async () => {
      const writes: DbWrite[] = [];
      // Display: A (Highest, unranked) then B (Highest, ranked); the moved
      // task is Normal, further down.
      const db = reorderDb(writes, [
        { id: ID_A, sortRank: null, priority: 2 },
        { id: ID_B, sortRank: 512, priority: 2 },
        { id: TASK_ID, sortRank: null, priority: 0 },
      ]);
      const { deps } = createDeps(db);
      const app = buildServer(deps);

      const res = await inject(app, { afterTaskId: ID_A });

      expect(res.statusCode).toBe(200);
      // No row above → the tier of the row it was dropped above (Highest).
      // A is unranked, so the destination tier resequences (A 1024, B 2048)
      // and the moved row lands one gap above A: rank 0.
      expect(res.json()).toEqual({ ok: true, sortRank: 0, priority: 2 });
      const updates = writes
        .filter((w) => w.method === 'update')
        .map((w) => w.arg);
      expect(updates).toEqual([
        { sortRank: 1024 },
        { sortRank: 2048 },
        { sortRank: 0, priority: 2 },
      ]);
    });

    it('resequencing is PER TIER: a lazy re-rank in the drop tier never touches another tier', async () => {
      const writes: DbWrite[] = [];
      // C is a ranked Highest row; A and B are unranked Normal rows. The
      // Normal task drops between A and B — only the Normal tier (A, B)
      // resequences; C keeps its 512 untouched.
      const db = reorderDb(writes, [
        { id: ID_C, sortRank: 512, priority: 2 },
        { id: ID_A, sortRank: null, priority: 0 },
        { id: ID_B, sortRank: null, priority: 0 },
        { id: TASK_ID, sortRank: null, priority: 0 },
      ]);
      const { deps } = createDeps(db);
      const app = buildServer(deps);

      const res = await inject(app, { beforeTaskId: ID_A, afterTaskId: ID_B });

      expect(res.statusCode).toBe(200);
      // Within-tier drop: no {priority} in the response or the write.
      expect(res.json()).toEqual({ ok: true, sortRank: 1536 });
      // Exactly three writes — A 1024, B 2048, midpoint — and none for C
      // (512 is not a RANK_GAP multiple, so a section-wide resequence would
      // have rewritten it).
      expect(rankWrites(writes)).toEqual([1024, 2048, 1536]);
    });

    it('responds 409 for a task outside "Waiting on you" (no manual order there)', async () => {
      for (const state of ['QUEUED', 'SUBMITTED', 'DISCARDED', 'FAILED']) {
        const writes: DbWrite[] = [];
        const db = reorderDb(writes, [], { state });
        const { deps } = createDeps(db);
        const app = buildServer(deps);

        const res = await inject(app, { beforeTaskId: ID_A });

        expect(res.statusCode).toBe(409);
        expect(res.json()).toEqual({
          error: `cannot reorder a task in state '${state}' — only "Waiting on you" tasks have a manual order`,
        });
        expect(writes).toEqual([]);
      }
    });

    it('responds 400 when no neighbor is provided, or a neighbor is the task itself', async () => {
      const { deps } = createDeps(
        createFakeDb({ selectResults: [[{ state: 'NEEDS_INPUT' }]] }),
      );
      const app = buildServer(deps);

      const empty = await inject(app, {});
      expect(empty.statusCode).toBe(400);
      expect(empty.json()).toMatchObject({ error: 'invalid body' });

      const self = await inject(app, { beforeTaskId: TASK_ID });
      expect(self.statusCode).toBe(400);
      expect(self.json()).toEqual({
        error: 'beforeTaskId/afterTaskId must be two OTHER tasks',
      });
    });

    it('responds 400 when a neighbor is not in the "Waiting on you" section', async () => {
      const writes: DbWrite[] = [];
      const db = reorderDb(writes, [{ id: ID_A, sortRank: 1024 }]);
      const { deps } = createDeps(db);
      const app = buildServer(deps);

      // ID_B is not in the section list.
      const res = await inject(app, { beforeTaskId: ID_B });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({
        error: 'neighbor task is not in the "Waiting on you" section',
      });
      expect(writes).toEqual([]);
    });

    it('responds 404 for a missing task, 400 for an invalid id, 401 without a key', async () => {
      const { deps } = createDeps(createFakeDb({ selectResults: [[]] }));
      const app = buildServer(deps);

      const missing = await inject(app, { beforeTaskId: ID_A });
      expect(missing.statusCode).toBe(404);
      expect(missing.json()).toEqual({ error: 'task not found' });

      const invalid = await inject(app, { beforeTaskId: ID_A }, 'not-a-uuid');
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json()).toMatchObject({ error: 'invalid task id' });

      const unauthed = await app.inject({
        method: 'POST',
        url: `/tasks/${TASK_ID}/reorder`,
        payload: { beforeTaskId: ID_A },
      });
      expect(unauthed.statusCode).toBe(401);
    });
  });

  describe('POST /tasks/clear-order', () => {
    it('nulls the waiting-section ranks in one conditional update (H6)', async () => {
      const writes: DbWrite[] = [];
      const { deps } = createDeps(createFakeDb({ writes }));
      const app = buildServer(deps);

      const res = await app.inject({
        method: 'POST',
        url: '/tasks/clear-order',
        headers: { 'x-api-key': 'test-key' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
      const updates = writes.filter(
        (w) => w.method === 'update' && w.table === applicationTasks,
      );
      expect(updates).toHaveLength(1);
      expect(updates[0]?.arg).toEqual({ sortRank: null });
    });

    it('responds 401 without an api key (guarded like every route)', async () => {
      const { deps } = createDeps(createFakeDb());
      const app = buildServer(deps);
      const res = await app.inject({
        method: 'POST',
        url: '/tasks/clear-order',
      });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('POST /ingest/manual (no-url manual entry)', () => {
    function inject(app: ReturnType<typeof buildServer>, payload: unknown) {
      return app.inject({
        method: 'POST',
        url: '/ingest/manual',
        headers: { 'x-api-key': 'test-key' },
        payload: payload as Record<string, unknown>,
      });
    }

    it('records the job under manual://<uuid>, parks it NEEDS_INPUT, and applies notes+priority', async () => {
      // The manual:// placeholder detects as unknown platform (real behavior;
      // the byUrl map cannot know the random uuid so the default ref applies).
      platformState.ref = {
        platform: 'unknown',
        tenant: null,
        externalId: null,
      };
      const writes: DbWrite[] = [];
      const db = createFakeDb({
        selectResults: [[]], // canonical-url dup check: fresh
        insertResults: [
          [{ id: 'job-m' }],
          [{ id: 'task-m' }],
          [], // PARSE_OK event
          [], // PARK event
        ],
        writes,
      });
      const { deps, enqueueProcess } = createDeps(db);
      const app = buildServer(deps);

      const res = await inject(app, {
        company: 'Acme Robotics',
        title: 'Controls Intern',
        notes: 'met at the career fair',
        priority: 1,
      });

      expect(res.statusCode).toBe(201);
      expect(res.json()).toEqual({
        ok: true,
        taskId: 'task-m',
        jobId: 'job-m',
      });

      // The job row: manual:// placeholder URL, source manual, user identity.
      const jobInsert = writes.find(
        (w) => w.method === 'insert' && w.table === jobs,
      );
      expect(jobInsert?.arg).toMatchObject({
        source: 'manual',
        company: 'Acme Robotics',
        title: 'Controls Intern',
        platform: 'unknown',
      });
      const jobArg = jobInsert?.arg as { url: string; canonicalUrl: string };
      expect(jobArg.url).toMatch(/^manual:\/\/[0-9a-f-]{36}$/);
      expect(jobArg.canonicalUrl).toBe(jobArg.url);

      // resolve:false — the placeholder is never GETed.
      expect(platformState.resolveCalls).toEqual([]);

      // Unknown platform parks (PARK -> NEEDS_INPUT); nothing is enqueued.
      const parkEvent = writes
        .filter((w) => w.method === 'insert' && w.table === events)
        .map((w) => w.arg as Record<string, unknown>)
        .find((arg) => arg.type === 'PARK');
      expect(parkEvent).toMatchObject({
        taskId: 'task-m',
        toState: 'NEEDS_INPUT',
      });
      expect(enqueueProcess).not.toHaveBeenCalled();

      // Notes + priority landed on the freshly parked task.
      const metaUpdate = writes
        .filter((w) => w.method === 'update' && w.table === applicationTasks)
        .map((w) => w.arg as Record<string, unknown>)
        .find((arg) => 'notes' in arg || 'priority' in arg);
      expect(metaUpdate).toMatchObject({
        notes: 'met at the career fair',
        priority: 1,
      });
    });

    it('writes no meta update when notes/priority are omitted', async () => {
      platformState.ref = {
        platform: 'unknown',
        tenant: null,
        externalId: null,
      };
      const writes: DbWrite[] = [];
      const db = createFakeDb({
        selectResults: [[]],
        insertResults: [[{ id: 'job-m' }], [{ id: 'task-m' }], [], []],
        writes,
      });
      const { deps } = createDeps(db);
      const app = buildServer(deps);

      const res = await inject(app, { company: 'Acme Robotics' });

      expect(res.statusCode).toBe(201);
      expect(res.json()).toEqual({
        ok: true,
        taskId: 'task-m',
        jobId: 'job-m',
      });
      const metaUpdates = writes
        .filter((w) => w.method === 'update' && w.table === applicationTasks)
        .map((w) => w.arg as Record<string, unknown>)
        .filter((arg) => 'notes' in arg || 'priority' in arg);
      expect(metaUpdates).toEqual([]);
    });

    it('responds 400 for an invalid body (nothing ingested)', async () => {
      for (const payload of [
        {},
        { company: '' },
        { company: '   ' },
        { company: 'Acme', priority: 3 },
        { company: 'Acme', notes: 'x'.repeat(20_001) },
      ]) {
        const writes: DbWrite[] = [];
        const { deps } = createDeps(createFakeDb({ writes }));
        const app = buildServer(deps);

        const res = await inject(app, payload);

        expect(res.statusCode).toBe(400);
        expect(res.json()).toMatchObject({ error: 'invalid body' });
        expect(writes).toEqual([]);
      }
    });

    it('responds 401 without an api key (guarded like every route)', async () => {
      const { deps } = createDeps(createFakeDb());
      const app = buildServer(deps);
      const res = await app.inject({
        method: 'POST',
        url: '/ingest/manual',
        payload: { company: 'Acme' },
      });
      expect(res.statusCode).toBe(401);
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
