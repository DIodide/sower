import { applicationTasks, events, jobs } from '@sower/db';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from './config.js';
import { buildServer } from './server.js';
import type { Deps } from './types.js';

const platformState = vi.hoisted(() => ({
  ref: {
    platform: 'greenhouse',
    tenant: 'acme',
    externalId: '123',
  } as { platform: string; tenant: string | null; externalId: string | null },
  /** Per-URL overrides consulted before the default ref. */
  byUrl: {} as Record<
    string,
    { platform: string; tenant: string | null; externalId: string | null }
  >,
}));

/** Verified greenhouse tenant probe: what it reports + how it was called. */
const probeState = vi.hoisted(() => ({
  tenant: null as string | null,
  calls: [] as Array<{ url: string; jobId: string }>,
}));

/** Tasks refreshIngestReply was asked to re-render the #ingest reply for. */
const refreshState = vi.hoisted(() => ({ calls: [] as string[] }));

/** Tasks the reingest route asked triggerInvestigation to run. */
const investigateState = vi.hoisted(() => ({ calls: [] as string[] }));

// The refresh primitive is proven in ingest-reply.test.ts; here we only
// assert the endpoint invokes it (it never throws, so a fake fn suffices).
vi.mock('./ingest-reply.js', () => ({
  refreshIngestReply: vi.fn(async (_deps: unknown, taskId: string) => {
    refreshState.calls.push(taskId);
  }),
}));

// The trigger itself is proven in investigate-trigger.test.ts; here we only
// assert the endpoint invokes it for parked spawns (it never throws).
vi.mock('./investigate-trigger.js', () => ({
  triggerInvestigation: vi.fn(async (_deps: unknown, taskId: string) => {
    investigateState.calls.push(taskId);
    return true;
  }),
}));

vi.mock('@sower/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@sower/core')>()),
  canonicalizeUrl: (url: string) => url.toLowerCase().replace(/\/+$/, ''),
}));

vi.mock('@sower/platforms', () => ({
  detectPlatform: (url: string) =>
    platformState.byUrl[url] ?? platformState.ref,
  resolveUrl: async (url: string) => url,
  // Verified tenant probe (unit-tested in @sower/platforms); null = no
  // verified tenant, so the job row is never upgraded.
  deriveGreenhouseTenant: async (url: string, jobId: string) => {
    probeState.calls.push({ url, jobId });
    return probeState.tenant;
  },
  // Only greenhouse has an adapter in this mock (mirrors server.test.ts; the
  // real registry is covered by @sower/platforms registry.test.ts).
  getAdapter: (platform: string) =>
    platform === 'greenhouse'
      ? {
          discover: async () => ({
            platform: 'greenhouse',
            tenant: 'acme',
            externalId: '123',
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

interface Chain {
  from: () => Chain;
  where: () => Chain;
  limit: () => Chain;
  innerJoin: () => Chain;
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
  RESUME_EDITOR_JOB_NAME: 'sower-resume-editor',
  RESUME_EDITOR_ENABLED: false,
  DASHBOARD_BASE_URL: undefined,
};

function createDeps(db: Deps['db']) {
  const enqueueProcess = vi.fn(async (_taskId: string) => {});
  const deps: Deps = { db, queue: { enqueueProcess }, config, logger: false };
  return { deps, enqueueProcess };
}

const OLD_TASK_ID = '7d8e9f10-1112-4314-a516-b71819c2d2e2';

/** The task+job join row the route loads first. */
function taskJobRow(
  state: string,
  jobOverrides: Record<string, unknown> = {},
): unknown {
  return {
    task: { id: OLD_TASK_ID, state, jobId: 'job-1' },
    job: {
      id: 'job-1',
      url: 'https://job-boards.greenhouse.io/acme/jobs/123',
      canonicalUrl: 'https://job-boards.greenhouse.io/acme/jobs/123',
      company: 'Acme',
      title: 'Software Engineer Intern',
      platform: 'greenhouse',
      tenant: 'acme',
      externalId: '123',
      dedupeKey: 'greenhouse:acme:123',
      ...jobOverrides,
    },
  };
}

/** The events-table inserts recorded, in order. */
function eventInserts(writes: DbWrite[]): Record<string, unknown>[] {
  return writes
    .filter((write) => write.method === 'insert' && write.table === events)
    .map((write) => write.arg as Record<string, unknown>);
}

/** The application_tasks row updates recorded, in order. */
function taskUpdates(writes: DbWrite[]): Record<string, unknown>[] {
  return writes
    .filter(
      (write) => write.method === 'update' && write.table === applicationTasks,
    )
    .map((write) => write.arg as Record<string, unknown>);
}

beforeEach(() => {
  platformState.ref = {
    platform: 'greenhouse',
    tenant: 'acme',
    externalId: '123',
  };
  platformState.byUrl = {};
  probeState.tenant = null;
  probeState.calls = [];
  refreshState.calls = [];
  investigateState.calls = [];
});

describe('POST /tasks/:id/reingest', () => {
  it('responds 401 without an api key', async () => {
    const { deps } = createDeps(createFakeDb());
    const app = buildServer(deps);
    const res = await app.inject({
      method: 'POST',
      url: `/tasks/${OLD_TASK_ID}/reingest`,
    });
    expect(res.statusCode).toBe(401);
  });

  it('responds 400 for a non-uuid task id', async () => {
    const { deps } = createDeps(createFakeDb());
    const app = buildServer(deps);
    const res = await app.inject({
      method: 'POST',
      url: '/tasks/not-a-uuid/reingest',
      headers: { 'x-api-key': 'test-key' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('responds 404 for a missing task', async () => {
    const { deps } = createDeps(createFakeDb({ selectResults: [[]] }));
    const app = buildServer(deps);
    const res = await app.inject({
      method: 'POST',
      url: `/tasks/${OLD_TASK_ID}/reingest`,
      headers: { 'x-api-key': 'test-key' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'task not found' });
  });

  it('re-ingests a supported job IN PLACE: same task id resets to INGESTED then ends QUEUED + enqueued', async () => {
    const writes: DbWrite[] = [];
    const db = createFakeDb({
      selectResults: [[taskJobRow('NEEDS_INPUT')]],
      writes,
    });
    const { deps, enqueueProcess } = createDeps(db);
    const app = buildServer(deps);

    const res = await app.inject({
      method: 'POST',
      url: `/tasks/${OLD_TASK_ID}/reingest`,
      headers: { 'x-api-key': 'test-key' },
    });

    expect(res.statusCode).toBe(200);
    // No newTaskId anymore: the task IS the task.
    expect(res.json()).toEqual({ ok: true, state: 'QUEUED' });
    expect(enqueueProcess).toHaveBeenCalledTimes(1);
    expect(enqueueProcess).toHaveBeenCalledWith(OLD_TASK_ID);

    // NO new task row: the reset happens on the existing row.
    const taskInsert = writes.find(
      (write) => write.method === 'insert' && write.table === applicationTasks,
    );
    expect(taskInsert).toBeUndefined();

    const inserted = eventInserts(writes);
    // The SAME task walks REINGEST -> PARSE_OK -> ENQUEUE, in order.
    expect(inserted.map((event) => event.type)).toEqual([
      'REINGEST',
      'PARSE_OK',
      'ENQUEUE',
    ]);
    expect(inserted[0]).toMatchObject({
      taskId: OLD_TASK_ID,
      type: 'REINGEST',
      fromState: 'NEEDS_INPUT',
      toState: 'INGESTED',
      data: { reason: 'manual' },
    });
    expect(inserted[1]).toMatchObject({
      taskId: OLD_TASK_ID,
      type: 'PARSE_OK',
      toState: 'PARSED',
    });
    expect(inserted[2]).toMatchObject({
      taskId: OLD_TASK_ID,
      type: 'ENQUEUE',
      toState: 'QUEUED',
    });

    // The REINGEST row update clears the pipeline artifacts atomically…
    expect(taskUpdates(writes)[0]).toMatchObject({
      state: 'INGESTED',
      attempt: 0,
      lastError: null,
      jobSpec: null,
      resolution: null,
    });
    // …and NEVER touches user annotations (notes/priority/dueDate/sortRank/
    // ingest reply refs survive a reingest).
    for (const update of taskUpdates(writes)) {
      expect(update).not.toHaveProperty('notes');
      expect(update).not.toHaveProperty('priority');
      expect(update).not.toHaveProperty('dueDate');
      expect(update).not.toHaveProperty('sortRank');
      expect(update).not.toHaveProperty('ingestChannelId');
      expect(update).not.toHaveProperty('ingestMessageId');
    }

    // The #ingest reply line returns to queued as the state settles.
    expect(refreshState.calls).toEqual([OLD_TASK_ID]);
    // A queued reset needs no investigation; the stored identity was already
    // discoverable, so the probe was never consulted either.
    expect(investigateState.calls).toEqual([]);
    expect(probeState.calls).toEqual([]);
  });

  it('re-ingests an unknown-platform job: the SAME task re-parks NEEDS_INPUT and investigation is triggered', async () => {
    platformState.ref = { platform: 'unknown', tenant: null, externalId: null };
    const writes: DbWrite[] = [];
    const db = createFakeDb({
      selectResults: [
        [
          taskJobRow('NEEDS_INPUT', {
            url: 'https://example.com/careers/some-job',
            canonicalUrl: 'https://example.com/careers/some-job',
            platform: 'unknown',
            tenant: null,
            externalId: null,
            dedupeKey: 'https://example.com/careers/some-job',
          }),
        ],
      ],
      writes,
    });
    const { deps, enqueueProcess } = createDeps(db);
    const app = buildServer(deps);

    const res = await app.inject({
      method: 'POST',
      url: `/tasks/${OLD_TASK_ID}/reingest`,
      headers: { 'x-api-key': 'test-key' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, state: 'NEEDS_INPUT' });
    expect(enqueueProcess).not.toHaveBeenCalled();

    const inserted = eventInserts(writes);
    expect(inserted.map((event) => event.type)).toEqual([
      'REINGEST',
      'PARSE_OK',
      'PARK',
    ]);
    expect(inserted[2]).toMatchObject({
      taskId: OLD_TASK_ID,
      type: 'PARK',
      toState: 'NEEDS_INPUT',
      data: { reason: 'unknown platform' },
    });
    // The pipeline artifacts were cleared even though the task re-parks:
    // the fresh run (or the browser agent) rebuilds them.
    expect(taskUpdates(writes)[0]).toMatchObject({
      state: 'INGESTED',
      attempt: 0,
      lastError: null,
      jobSpec: null,
      resolution: null,
    });
    // Parked reset: the (self-gating) Tier-2 form discovery was offered for
    // THIS task — no replacement exists.
    expect(investigateState.calls).toEqual([OLD_TASK_ID]);
    expect(refreshState.calls).toEqual([OLD_TASK_ID]);
  });

  it('refuses SUBMITTED and CONFIRMED tasks with a 409 (mark it un-applied first)', async () => {
    for (const state of ['SUBMITTED', 'CONFIRMED']) {
      const writes: DbWrite[] = [];
      const db = createFakeDb({
        selectResults: [[taskJobRow(state)]],
        writes,
      });
      const { deps, enqueueProcess } = createDeps(db);
      const app = buildServer(deps);
      const res = await app.inject({
        method: 'POST',
        url: `/tasks/${OLD_TASK_ID}/reingest`,
        headers: { 'x-api-key': 'test-key' },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toContain('mark it un-applied first');
      // Nothing was written, spawned, or enqueued.
      expect(writes).toEqual([]);
      expect(enqueueProcess).not.toHaveBeenCalled();
      expect(refreshState.calls).toEqual([]);
    }
  });

  it('re-ingests a DISCARDED task straight from the archive: in-place reset, no restore-first dance', async () => {
    const writes: DbWrite[] = [];
    const db = createFakeDb({
      selectResults: [[taskJobRow('DISCARDED')]],
      writes,
    });
    const { deps, enqueueProcess } = createDeps(db);
    const app = buildServer(deps);

    const res = await app.inject({
      method: 'POST',
      url: `/tasks/${OLD_TASK_ID}/reingest`,
      headers: { 'x-api-key': 'test-key' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, state: 'QUEUED' });
    expect(enqueueProcess).toHaveBeenCalledWith(OLD_TASK_ID);

    const inserted = eventInserts(writes);
    // The archived task itself leaves the archive via REINGEST -> INGESTED.
    expect(inserted.map((event) => event.type)).toEqual([
      'REINGEST',
      'PARSE_OK',
      'ENQUEUE',
    ]);
    expect(inserted[0]).toMatchObject({
      taskId: OLD_TASK_ID,
      type: 'REINGEST',
      fromState: 'DISCARDED',
      toState: 'INGESTED',
    });
    // No new task row spawned.
    const taskInsert = writes.find(
      (write) => write.method === 'insert' && write.table === applicationTasks,
    );
    expect(taskInsert).toBeUndefined();
  });

  it('re-ingests a DUPLICATE task in place (job-level dedupe is unaffected)', async () => {
    const writes: DbWrite[] = [];
    const db = createFakeDb({
      selectResults: [[taskJobRow('DUPLICATE')]],
      writes,
    });
    const { deps, enqueueProcess } = createDeps(db);
    const app = buildServer(deps);

    const res = await app.inject({
      method: 'POST',
      url: `/tasks/${OLD_TASK_ID}/reingest`,
      headers: { 'x-api-key': 'test-key' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, state: 'QUEUED' });
    expect(enqueueProcess).toHaveBeenCalledWith(OLD_TASK_ID);
    const inserted = eventInserts(writes);
    expect(inserted[0]).toMatchObject({
      taskId: OLD_TASK_ID,
      type: 'REINGEST',
      fromState: 'DUPLICATE',
      toState: 'INGESTED',
    });
  });

  it('upgrades the job row via the verified greenhouse tenant probe before the in-place reset', async () => {
    // The akuna shape: stored tenant-less greenhouse (parked at ingest —
    // gh_jid on the company's own domain). The probe can NOW verify the
    // tenant, so reingest adopts the canonical board identity onto the jobs
    // row FIRST and the SAME task queues instead of re-parking.
    const pageUrl =
      'https://akunacapital.com/careers/job/8018853/swe?gh_jid=8018853';
    const boardUrl =
      'https://job-boards.greenhouse.io/akunacapital/jobs/8018853';
    platformState.byUrl[pageUrl] = {
      platform: 'greenhouse',
      tenant: null,
      externalId: '8018853',
    };
    probeState.tenant = 'akunacapital';
    const writes: DbWrite[] = [];
    const db = createFakeDb({
      selectResults: [
        [
          taskJobRow('NEEDS_INPUT', {
            url: pageUrl,
            canonicalUrl: pageUrl,
            platform: 'greenhouse',
            tenant: null,
            externalId: '8018853',
            dedupeKey: 'greenhouse:jid:8018853',
          }),
        ],
        [], // collision check: no other row owns the board identity
      ],
      writes,
    });
    const { deps, enqueueProcess } = createDeps(db);
    const app = buildServer(deps);

    const res = await app.inject({
      method: 'POST',
      url: `/tasks/${OLD_TASK_ID}/reingest`,
      headers: { 'x-api-key': 'test-key' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, state: 'QUEUED' });
    // The probe ran against the row's CURRENT url + external id.
    expect(probeState.calls).toEqual([{ url: pageUrl, jobId: '8018853' }]);
    // The jobs row adopted the verified identity + canonical board URL.
    const jobUpdate = writes.find(
      (write) => write.method === 'update' && write.table === jobs,
    );
    expect(jobUpdate?.arg).toEqual({
      platform: 'greenhouse',
      tenant: 'akunacapital',
      externalId: '8018853',
      url: boardUrl,
      canonicalUrl: boardUrl,
      dedupeKey: 'greenhouse:akunacapital:8018853',
    });
    // The SAME task queued as a normal supported greenhouse job, its
    // PARSE_OK recorded against the upgraded canonical URL.
    const inserted = eventInserts(writes);
    expect(inserted.map((event) => event.type)).toEqual([
      'REINGEST',
      'PARSE_OK',
      'ENQUEUE',
    ]);
    expect(inserted[1]).toMatchObject({
      taskId: OLD_TASK_ID,
      type: 'PARSE_OK',
      data: { canonicalUrl: boardUrl, platform: 'greenhouse' },
    });
    expect(enqueueProcess).toHaveBeenCalledWith(OLD_TASK_ID);
    expect(investigateState.calls).toEqual([]);
  });
});
