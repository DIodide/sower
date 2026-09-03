import { answers, applicationTasks, events } from '@sower/db';
import { describe, expect, it } from 'vitest';
import type { Config } from './config.js';
import { buildServer } from './server.js';
import type { Deps } from './types.js';

/**
 * POST /tasks/:id/answers against a fake db: auth, 404 for an unknown
 * task, 409 without questions, the ALL-OR-NOTHING 400s (unknown
 * questionId, option mismatch, wrong-kind document) that write nothing,
 * the upsert shapes the shared writer produces (company-scoped text,
 * global {value,label} selects, multiselect arrays, document picks by
 * storagePath), and the two re-resolve paths: agent-discovered / unknown-
 * platform specs persist a fresh resolution + RESOLVED_* event, adapter
 * tasks get a preview and NO resolution write. The resolver is the real
 * @sower/answers (empty profile → only the bank rows the fake returns
 * resolve anything).
 */

interface Chain {
  from: () => Chain;
  where: () => Chain;
  limit: () => Chain;
  innerJoin: () => Chain;
  orderBy: () => Chain;
  values: (arg?: unknown) => Chain;
  set: (arg?: unknown) => Chain;
  returning: () => Chain;
  onConflictDoUpdate: (arg?: unknown) => Chain;
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
    set: (arg?: unknown) => {
      onArg?.(arg);
      return self;
    },
    returning: () => self,
    onConflictDoUpdate: () => self,
    // biome-ignore lint/suspicious/noThenProperty: intentionally thenable to mimic drizzle's awaitable query builder
    then: (onFulfilled) => Promise.resolve(result).then(onFulfilled),
  };
  return self;
}

interface DbWrite {
  method: 'insert' | 'update';
  table: unknown;
  arg: unknown;
}

function createFakeDb(
  options: { selectResults?: unknown[][]; writes?: DbWrite[] } = {},
): Deps['db'] {
  const selectResults = [...(options.selectResults ?? [])];
  const db = {
    select: () => chain(selectResults.shift() ?? []),
    insert: (table: unknown) =>
      chain([], (arg) =>
        options.writes?.push({ method: 'insert', table, arg }),
      ),
    update: (table: unknown) =>
      chain([], (arg) =>
        options.writes?.push({ method: 'update', table, arg }),
      ),
  };
  return db as unknown as Deps['db'];
}

const config = {
  INGEST_API_KEY: 'test-key',
  SOWER_ENV: 'test',
  // No file fallback: the fake's empty profiles select → the empty profile.
  PROFILE_PATH: undefined,
} as unknown as Config;

function createDeps(db: Deps['db']): Deps {
  return {
    db,
    queue: { enqueueProcess: async () => {} },
    config,
    logger: false,
  };
}

const TASK_ID = 'aaaaaaaa-0000-4000-8000-000000000001';
const JOB_ID = 'cccccccc-0000-4000-8000-000000000001';
const DOC_ID = 'eeeeeeee-0000-4000-8000-000000000001';
const AUTH = { 'x-api-key': 'test-key' };

const questions = [
  { id: 'q-name', label: 'Full name', type: 'text', required: true },
  { id: 'q-why', label: 'Why here?', type: 'textarea', required: false },
  {
    id: 'q-visa',
    label: 'Need sponsorship?',
    type: 'select',
    required: true,
    options: [
      { label: 'Yes', value: 1 },
      { label: 'No', value: 0 },
    ],
  },
  {
    id: 'q-langs',
    label: 'Languages',
    type: 'multiselect',
    required: false,
    options: [
      { label: 'TypeScript', value: 'ts' },
      { label: 'Rust', value: 'rs' },
    ],
  },
  { id: 'q-resume', label: 'Resume', type: 'file', required: true },
];

function joinRow(
  overrides: { spec?: Record<string, unknown> | null; platform?: string } = {},
) {
  const spec =
    overrides.spec === undefined
      ? {
          platform: 'greenhouse',
          tenant: 'acme',
          externalId: '1',
          title: 'SWE Intern',
          company: 'Acme',
          applyUrl: 'https://boards.greenhouse.io/acme/jobs/1',
          questions,
        }
      : overrides.spec;
  return {
    task: {
      id: TASK_ID,
      jobId: JOB_ID,
      state: 'NEEDS_INPUT',
      jobSpec: spec,
      resolution: null,
    },
    job: {
      id: JOB_ID,
      company: 'Acme Corp',
      title: 'SWE Intern',
      url: 'https://boards.greenhouse.io/acme/jobs/1',
      platform: overrides.platform ?? 'greenhouse',
      tenant: 'acme',
      externalId: '1',
    },
  };
}

function inject(
  app: ReturnType<typeof buildServer>,
  payload: unknown,
  id: string = TASK_ID,
) {
  return app.inject({
    method: 'POST',
    url: `/tasks/${id}/answers`,
    headers: AUTH,
    payload: payload as Record<string, unknown>,
  });
}

const upserts = (writes: DbWrite[]) =>
  writes.filter((w) => w.method === 'insert' && w.table === answers);

describe('POST /tasks/:id/answers', () => {
  it('requires the api key', async () => {
    const app = buildServer(createDeps(createFakeDb()));
    const res = await app.inject({
      method: 'POST',
      url: `/tasks/${TASK_ID}/answers`,
      payload: { answers: [{ questionId: 'q-name', value: 'x' }] },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('400s a malformed body and an invalid id without touching the db', async () => {
    const writes: DbWrite[] = [];
    const app = buildServer(createDeps(createFakeDb({ writes })));
    expect((await inject(app, { answers: [] })).statusCode).toBe(400);
    expect((await inject(app, { nope: 1 })).statusCode).toBe(400);
    expect(
      (await inject(app, { answers: [{ questionId: 'q', value: 1 }] }))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await inject(
          app,
          { answers: [{ questionId: 'q', value: 'x' }] },
          'nope',
        )
      ).statusCode,
    ).toBe(400);
    expect(writes).toEqual([]);
    await app.close();
  });

  it('404s an unknown task', async () => {
    const app = buildServer(createDeps(createFakeDb({ selectResults: [[]] })));
    const res = await inject(app, {
      answers: [{ questionId: 'q-name', value: 'x' }],
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'task not found' });
    await app.close();
  });

  it('409s a task without questions', async () => {
    const app = buildServer(
      createDeps(createFakeDb({ selectResults: [[joinRow({ spec: null })]] })),
    );
    const res = await inject(app, {
      answers: [{ questionId: 'q-name', value: 'x' }],
    });
    expect(res.statusCode).toBe(409);
    await app.close();
  });

  it('400s an unknown questionId and writes NOTHING (all-or-nothing)', async () => {
    const writes: DbWrite[] = [];
    const app = buildServer(
      createDeps(createFakeDb({ selectResults: [[joinRow()]], writes })),
    );
    const res = await inject(app, {
      answers: [
        { questionId: 'q-name', value: 'Jane' },
        { questionId: 'ghost', value: 'x' },
      ],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: 'invalid answers',
      issues: [
        {
          questionId: 'ghost',
          label: null,
          message: 'not a question of this task',
        },
      ],
    });
    expect(writes).toEqual([]);
    await app.close();
  });

  it('400s a select value that is not one of the options', async () => {
    const writes: DbWrite[] = [];
    const app = buildServer(
      createDeps(createFakeDb({ selectResults: [[joinRow()]], writes })),
    );
    const res = await inject(app, {
      answers: [{ questionId: 'q-visa', value: 'No' }],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().issues[0]).toEqual({
      questionId: 'q-visa',
      label: 'Need sponsorship?',
      message: "value not among the question's options",
    });
    expect(writes).toEqual([]);
    await app.close();
  });

  it('400s a document of the wrong kind for a file question', async () => {
    const writes: DbWrite[] = [];
    const app = buildServer(
      createDeps(
        createFakeDb({
          selectResults: [
            [joinRow()],
            // The documents table the writer reads for file answers.
            [{ id: DOC_ID, kind: 'cover_letter', storagePath: 'docs/cl.pdf' }],
          ],
          writes,
        }),
      ),
    );
    const res = await inject(app, {
      answers: [{ questionId: 'q-resume', value: DOC_ID }],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().issues[0].message).toBe(
      'selected document is kind "cover_letter", expected "resume"',
    );
    expect(writes).toEqual([]);
    await app.close();
  });

  it('adapter task: upserts with the dashboard shapes, previews the resolution, persists nothing', async () => {
    const writes: DbWrite[] = [];
    const db = createFakeDb({
      selectResults: [
        [joinRow()],
        // documents (file answer in the batch)
        [{ id: DOC_ID, kind: 'resume', storagePath: 'docs/resume.pdf' }],
        // computeResolution: profiles (none → empty profile), the bank AS
        // IF the writes above landed, documents
        [],
        [
          {
            normalizedLabel: 'full name',
            value: 'Jane Doe',
            company: 'acme corp',
          },
          {
            normalizedLabel: 'need sponsorship',
            value: { value: '0', label: 'No' },
            company: '',
          },
          {
            normalizedLabel: 'resume',
            value: 'docs/resume.pdf',
            company: 'acme corp',
          },
        ],
        [{ kind: 'resume', storagePath: 'docs/resume.pdf', filename: 'r.pdf' }],
      ],
      writes,
    });
    const app = buildServer(createDeps(db));
    const res = await inject(app, {
      answers: [
        { questionId: 'q-name', value: ' Jane Doe ' },
        { questionId: 'q-why', value: 'Because.', scope: 'global' },
        { questionId: 'q-visa', value: '0' },
        { questionId: 'q-langs', value: ['ts', 'rs'] },
        { questionId: 'q-resume', value: DOC_ID },
      ],
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      saved: 5,
      // q-name (bank, company-scoped), q-visa (bank), q-resume (document)
      // resolve; q-why / q-langs stay missing in the fake bank.
      resolution: {
        resolved: 3,
        missing: 2,
        requiredMissing: 0,
        persisted: false,
      },
    });
    expect(upserts(writes).map((w) => w.arg)).toEqual([
      {
        questionLabel: 'Full name',
        normalizedLabel: 'full name',
        value: 'Jane Doe',
        source: 'user',
        company: 'acme corp',
      },
      {
        questionLabel: 'Why here?',
        normalizedLabel: 'why here',
        value: 'Because.',
        source: 'user',
        company: '',
      },
      {
        questionLabel: 'Need sponsorship?',
        normalizedLabel: 'need sponsorship',
        value: { value: '0', label: 'No' },
        source: 'user',
        company: '',
      },
      {
        questionLabel: 'Languages',
        normalizedLabel: 'languages',
        value: [
          { value: 'ts', label: 'TypeScript' },
          { value: 'rs', label: 'Rust' },
        ],
        source: 'user',
        company: '',
      },
      {
        questionLabel: 'Resume',
        normalizedLabel: 'resume',
        value: 'docs/resume.pdf',
        source: 'user',
        company: 'acme corp',
      },
    ]);
    // Preview only: the process-owned resolution and the timeline are
    // untouched — `sower requeue` applies the answers for real.
    expect(writes.filter((w) => w.table === applicationTasks)).toEqual([]);
    expect(writes.filter((w) => w.table === events)).toEqual([]);
    await app.close();
  });

  it('agent-discovered spec: re-resolves IN PLACE (resolution write + RESOLVED_* event)', async () => {
    const writes: DbWrite[] = [];
    const discovered = joinRow({
      spec: {
        platform: 'unknown',
        tenant: '',
        externalId: '',
        title: 'SWE Intern',
        applyUrl: 'https://careers.example.com/apply',
        questions: questions.slice(0, 3),
        discoveredByAgent: true,
      },
      platform: 'unknown',
    });
    const db = createFakeDb({
      selectResults: [
        [discovered],
        // resolveDiscoveredTask's own task+job re-select, then
        // computeResolution: profiles, bank, documents
        [discovered],
        [],
        [{ normalizedLabel: 'full name', value: 'Jane', company: 'acme corp' }],
        [],
      ],
      writes,
    });
    const app = buildServer(createDeps(db));
    const res = await inject(app, {
      answers: [{ questionId: 'q-name', value: 'Jane' }],
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      saved: 1,
      resolution: {
        resolved: 1,
        missing: 2,
        requiredMissing: 1,
        persisted: true,
      },
    });
    const resolutionWrite = writes.find(
      (w) => w.method === 'update' && w.table === applicationTasks,
    );
    expect(resolutionWrite?.arg).toMatchObject({
      resolution: { requiredMissingCount: 1, optionalMissingCount: 1 },
    });
    const event = writes.find(
      (w) => w.method === 'insert' && w.table === events,
    );
    expect(event?.arg).toMatchObject({
      taskId: TASK_ID,
      type: 'RESOLVED_PARTIAL',
      data: { resolved: 1, missing: 2, requiredMissing: 1 },
    });
    await app.close();
  });

  it('unknown-platform job without discoveredByAgent also takes the in-place path', async () => {
    const writes: DbWrite[] = [];
    const row = joinRow({
      spec: {
        platform: 'unknown',
        tenant: '',
        externalId: '',
        title: 'Role',
        applyUrl: 'https://x.example',
        questions: [questions[0]],
      },
      platform: 'unknown',
    });
    const db = createFakeDb({
      selectResults: [
        [row],
        [row],
        [],
        [{ normalizedLabel: 'full name', value: 'Jane', company: '' }],
        [],
      ],
      writes,
    });
    const app = buildServer(createDeps(db));
    const res = await inject(app, {
      answers: [{ questionId: 'q-name', value: 'Jane', scope: 'global' }],
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().resolution).toEqual({
      resolved: 1,
      missing: 0,
      requiredMissing: 0,
      persisted: true,
    });
    expect(
      writes.find((w) => w.method === 'insert' && w.table === events)?.arg,
    ).toMatchObject({ type: 'RESOLVED_ALL' });
    await app.close();
  });
});
