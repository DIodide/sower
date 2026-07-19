import { resumeRuns } from '@sower/db';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from './config.js';
import { buildServer } from './server.js';
import type { Deps } from './types.js';

/** What the routes asked runCloudJob to start. */
const jobState = vi.hoisted(() => ({
  calls: [] as { jobName: string; env: Record<string, string> }[],
  error: null as Error | null,
}));

// The Cloud Run trigger itself is proven in run-cloud-job.test.ts; here we
// only assert the routes gate + invoke it with the right job/env.
vi.mock('./run-cloud-job.js', () => ({
  runCloudJob: vi.fn(
    async (_deps: unknown, jobName: string, env: Record<string, string>) => {
      jobState.calls.push({ jobName, env });
      if (jobState.error) {
        throw jobState.error;
      }
    },
  ),
}));

interface Chain {
  from: () => Chain;
  where: () => Chain;
  limit: () => Chain;
  orderBy: () => Chain;
  values: (arg?: unknown) => Chain;
  returning: () => Chain;
  then: (onFulfilled: (value: unknown) => unknown) => Promise<unknown>;
}

function chain(result: unknown, onArg?: (arg: unknown) => void): Chain {
  const self: Chain = {
    from: () => self,
    where: () => self,
    limit: () => self,
    orderBy: () => self,
    values: (arg?: unknown) => {
      onArg?.(arg);
      return self;
    },
    returning: () => self,
    // biome-ignore lint/suspicious/noThenProperty: intentionally thenable to mimic drizzle's awaitable query builder
    then: (onFulfilled) => Promise.resolve(result).then(onFulfilled),
  };
  return self;
}

interface DbWrite {
  table: unknown;
  arg: unknown;
}

function createFakeDb(
  options: {
    selectResults?: unknown[][];
    insertResults?: unknown[][];
    writes?: DbWrite[];
  } = {},
): Deps['db'] {
  const selectResults = [...(options.selectResults ?? [])];
  const insertResults = [...(options.insertResults ?? [])];
  const db = {
    select: () => chain(selectResults.shift() ?? []),
    insert: (table: unknown) =>
      chain(insertResults.shift() ?? [], (arg) =>
        options.writes?.push({ table, arg }),
      ),
  };
  return db as unknown as Deps['db'];
}

const baseConfig = {
  INGEST_API_KEY: 'test-key',
  SOWER_ENV: 'test',
  RESUME_EDITOR_JOB_NAME: 'sower-resume-editor',
  RESUME_EDITOR_ENABLED: true,
} as unknown as Config;

function createDeps(
  db: Deps['db'],
  configOverrides: Partial<Config> = {},
): Deps {
  return {
    db,
    queue: { enqueueProcess: vi.fn(async () => {}) },
    config: { ...baseConfig, ...configOverrides } as Config,
    logger: false,
  };
}

const RESUME_ID = '3f0a1b2c-4d5e-4f60-8172-93a4b5c6d7e8';
const RUN_ID = '9e8d7c6b-5a49-4838-a716-05f4e3d2c1b0';

const resumeRow = {
  id: RESUME_ID,
  name: 'swe-2027',
  texPath: 'developer/resumes/swe-2027.tex',
  texSource: '\\documentclass{article}',
  pdfStoragePath: 'resumes/swe-2027/swe-2027.pdf',
  documentId: null,
  lastCommitSha: 'abc123',
  updatedAt: new Date('2026-07-01T00:00:00Z'),
};

beforeEach(() => {
  jobState.calls = [];
  jobState.error = null;
});

describe('/resumes routes', () => {
  it('GET /resumes requires the api key', async () => {
    const app = buildServer(createDeps(createFakeDb()));
    const response = await app.inject({ method: 'GET', url: '/resumes' });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it('GET /resumes lists resumes with their latest run attached', async () => {
    const olderRun = {
      id: 'run-older',
      resumeId: RESUME_ID,
      kind: 'agent',
      status: 'succeeded',
      startedAt: new Date('2026-07-01T00:00:00Z'),
    };
    const latestRun = {
      id: RUN_ID,
      resumeId: RESUME_ID,
      kind: 'write',
      status: 'running',
      startedAt: new Date('2026-07-02T00:00:00Z'),
    };
    const db = createFakeDb({
      // 1: resumes list; 2: recency-ordered runs (latest first).
      selectResults: [[resumeRow], [latestRun, olderRun]],
    });
    const app = buildServer(createDeps(db));
    const response = await app.inject({
      method: 'GET',
      url: '/resumes',
      headers: { 'x-api-key': 'test-key' },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      resumes: { id: string; latestRun: { id: string } | null }[];
    };
    expect(body.resumes).toHaveLength(1);
    expect(body.resumes[0]?.id).toBe(RESUME_ID);
    // The FIRST run in recency order wins — never the older one.
    expect(body.resumes[0]?.latestRun?.id).toBe(RUN_ID);
    await app.close();
  });

  it('POST /resumes/sync is fully dormant when disabled: 503, no insert, no Job', async () => {
    const writes: DbWrite[] = [];
    const db = createFakeDb({ writes });
    const app = buildServer(createDeps(db, { RESUME_EDITOR_ENABLED: false }));
    const response = await app.inject({
      method: 'POST',
      url: '/resumes/sync',
      headers: { 'x-api-key': 'test-key' },
    });
    expect(response.statusCode).toBe(503);
    expect(writes).toEqual([]);
    expect(jobState.calls).toEqual([]);
    await app.close();
  });

  it('POST /resumes/sync inserts a sync run and starts the Job with RESUME_RUN_ID', async () => {
    const writes: DbWrite[] = [];
    const db = createFakeDb({ insertResults: [[{ id: RUN_ID }]], writes });
    const app = buildServer(createDeps(db));
    const response = await app.inject({
      method: 'POST',
      url: '/resumes/sync',
      headers: { 'x-api-key': 'test-key' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ runId: RUN_ID, fired: true });
    expect(writes).toEqual([
      {
        table: resumeRuns,
        // Repo-wide: no resumeId on a sync run.
        arg: { kind: 'sync', status: 'running' },
      },
    ]);
    expect(jobState.calls).toEqual([
      {
        jobName: 'sower-resume-editor',
        env: { RESUME_RUN_ID: RUN_ID },
      },
    ]);
    await app.close();
  });

  it('POST /resumes/sync reports fired:false (run still recorded) when the Job fails to start', async () => {
    jobState.error = new Error('cloud run down');
    const writes: DbWrite[] = [];
    const db = createFakeDb({ insertResults: [[{ id: RUN_ID }]], writes });
    const app = buildServer(createDeps(db));
    const response = await app.inject({
      method: 'POST',
      url: '/resumes/sync',
      headers: { 'x-api-key': 'test-key' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ runId: RUN_ID, fired: false });
    expect(writes).toHaveLength(1);
    await app.close();
  });

  it('POST /resumes/:id/edit 404s on an unknown resume', async () => {
    const db = createFakeDb({ selectResults: [[]] });
    const app = buildServer(createDeps(db));
    const response = await app.inject({
      method: 'POST',
      url: `/resumes/${RESUME_ID}/edit`,
      headers: { 'x-api-key': 'test-key' },
      payload: { content: '\\documentclass{article}' },
    });
    expect(response.statusCode).toBe(404);
    expect(jobState.calls).toEqual([]);
    await app.close();
  });

  it('POST /resumes/:id/edit rejects an empty body', async () => {
    const db = createFakeDb();
    const app = buildServer(createDeps(db));
    const response = await app.inject({
      method: 'POST',
      url: `/resumes/${RESUME_ID}/edit`,
      headers: { 'x-api-key': 'test-key' },
      payload: { content: '' },
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it('POST /resumes/:id/edit inserts a write run with prompt={texPath,content} JSON and triggers', async () => {
    const writes: DbWrite[] = [];
    const db = createFakeDb({
      selectResults: [[resumeRow]],
      insertResults: [[{ id: RUN_ID }]],
      writes,
    });
    const app = buildServer(createDeps(db));
    const content =
      '\\documentclass{article}\\begin{document}hi\\end{document}';
    const response = await app.inject({
      method: 'POST',
      url: `/resumes/${RESUME_ID}/edit`,
      headers: { 'x-api-key': 'test-key' },
      payload: { content },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ runId: RUN_ID, fired: true });
    expect(writes).toHaveLength(1);
    const arg = writes[0]?.arg as {
      resumeId: string;
      kind: string;
      prompt: string;
      status: string;
    };
    expect(arg.resumeId).toBe(RESUME_ID);
    expect(arg.kind).toBe('write');
    expect(arg.status).toBe('running');
    expect(JSON.parse(arg.prompt)).toEqual({
      texPath: 'developer/resumes/swe-2027.tex',
      content,
    });
    expect(jobState.calls).toEqual([
      { jobName: 'sower-resume-editor', env: { RESUME_RUN_ID: RUN_ID } },
    ]);
    await app.close();
  });

  it('POST /resumes/:id/ask validates the prompt length (1-4000)', async () => {
    const db = createFakeDb();
    const app = buildServer(createDeps(db));
    for (const prompt of ['', '   ', 'x'.repeat(4001)]) {
      const response = await app.inject({
        method: 'POST',
        url: `/resumes/${RESUME_ID}/ask`,
        headers: { 'x-api-key': 'test-key' },
        payload: { prompt },
      });
      expect(response.statusCode).toBe(400);
    }
    expect(jobState.calls).toEqual([]);
    await app.close();
  });

  it('POST /resumes/:id/ask inserts an agent run with the prompt and triggers', async () => {
    const writes: DbWrite[] = [];
    const db = createFakeDb({
      selectResults: [[{ id: RESUME_ID }]],
      insertResults: [[{ id: RUN_ID }]],
      writes,
    });
    const app = buildServer(createDeps(db));
    const response = await app.inject({
      method: 'POST',
      url: `/resumes/${RESUME_ID}/ask`,
      headers: { 'x-api-key': 'test-key' },
      payload: { prompt: 'Add my new internship at Acme to the top.' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ runId: RUN_ID, fired: true });
    expect(writes).toEqual([
      {
        table: resumeRuns,
        arg: {
          resumeId: RESUME_ID,
          kind: 'agent',
          prompt: 'Add my new internship at Acme to the top.',
          status: 'running',
        },
      },
    ]);
    expect(jobState.calls).toEqual([
      { jobName: 'sower-resume-editor', env: { RESUME_RUN_ID: RUN_ID } },
    ]);
    await app.close();
  });

  it('POST /resumes/:id/ask is dormant when disabled', async () => {
    const writes: DbWrite[] = [];
    const db = createFakeDb({ writes });
    const app = buildServer(createDeps(db, { RESUME_EDITOR_ENABLED: false }));
    const response = await app.inject({
      method: 'POST',
      url: `/resumes/${RESUME_ID}/ask`,
      headers: { 'x-api-key': 'test-key' },
      payload: { prompt: 'tweak it' },
    });
    expect(response.statusCode).toBe(503);
    expect(writes).toEqual([]);
    expect(jobState.calls).toEqual([]);
    await app.close();
  });

  it('GET /resumes/runs/:id returns the run row', async () => {
    const run = {
      id: RUN_ID,
      resumeId: RESUME_ID,
      kind: 'agent',
      status: 'succeeded',
      transcript: [{ seq: 0, kind: 'assistant_text', text: 'done', ts: 1 }],
      commitSha: 'def456',
      error: null,
    };
    const db = createFakeDb({ selectResults: [[run]] });
    const app = buildServer(createDeps(db));
    const response = await app.inject({
      method: 'GET',
      url: `/resumes/runs/${RUN_ID}`,
      headers: { 'x-api-key': 'test-key' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ run: JSON.parse(JSON.stringify(run)) });
    await app.close();
  });

  it('GET /resumes/runs/:id 404s on an unknown run and 400s on a non-uuid', async () => {
    const db = createFakeDb({ selectResults: [[]] });
    const app = buildServer(createDeps(db));
    const missing = await app.inject({
      method: 'GET',
      url: `/resumes/runs/${RUN_ID}`,
      headers: { 'x-api-key': 'test-key' },
    });
    expect(missing.statusCode).toBe(404);
    const invalid = await app.inject({
      method: 'GET',
      url: '/resumes/runs/not-a-uuid',
      headers: { 'x-api-key': 'test-key' },
    });
    expect(invalid.statusCode).toBe(400);
    await app.close();
  });
});
