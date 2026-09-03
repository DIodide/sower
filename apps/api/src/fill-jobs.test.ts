import type { JobSpec } from '@sower/core';
import { applicationTasks, events, fillJobs } from '@sower/db';
import { describe, expect, it } from 'vitest';
import type { Config } from './config.js';
import { fillTargetUrl } from './fill-jobs.js';
import { buildServer } from './server.js';
import type { Deps } from './types.js';

/**
 * /tasks/:id/fill + /fill-jobs routes against a fake db: the request guards
 * (404, platform/state 409s, the one-active-job 409 — with a STALE
 * claimed/running job NOT blocking), the claim's stale-heartbeat reap, the
 * FOR UPDATE SKIP LOCKED claim idiom, the RAW-values payload (resolved
 * input values — never display labels — the answers-bank 'saved' fallback,
 * file/unanswered null), the report/fail/heartbeat guards, and the event
 * rows each mutation appends. Status derivation itself is task-views
 * buildQuestions, proven by its other consumers; here the mapping of
 * status → raw input values is what's under test.
 */

interface Chain {
  from: () => Chain;
  where: (arg?: unknown) => Chain;
  limit: () => Chain;
  innerJoin: () => Chain;
  orderBy: () => Chain;
  values: (arg?: unknown) => Chain;
  set: (arg?: unknown) => Chain;
  returning: () => Chain;
  then: (onFulfilled: (value: unknown) => unknown) => Promise<unknown>;
}

interface DbWrite {
  method: 'insert' | 'update';
  table: unknown;
  arg?: unknown;
  where?: unknown;
}

function chain(result: unknown, write?: DbWrite): Chain {
  const self: Chain = {
    from: () => self,
    innerJoin: () => self,
    limit: () => self,
    orderBy: () => self,
    where: (arg?: unknown) => {
      if (write) {
        write.where = arg;
      }
      return self;
    },
    values: (arg?: unknown) => {
      if (write) {
        write.arg = arg;
      }
      return self;
    },
    set: (arg?: unknown) => {
      if (write) {
        write.arg = arg;
      }
      return self;
    },
    returning: () => self,
    // biome-ignore lint/suspicious/noThenProperty: intentionally thenable to mimic drizzle's awaitable query builder
    then: (onFulfilled) => Promise.resolve(result).then(onFulfilled),
  };
  return self;
}

function createFakeDb(
  options: {
    selectResults?: unknown[][];
    insertResults?: unknown[][];
    updateResults?: unknown[][];
    writes?: DbWrite[];
  } = {},
): Deps['db'] {
  const selectResults = [...(options.selectResults ?? [])];
  const insertResults = [...(options.insertResults ?? [])];
  const updateResults = [...(options.updateResults ?? [])];
  const db = {
    select: () => chain(selectResults.shift() ?? []),
    insert: (table: unknown) => {
      const write: DbWrite = { method: 'insert', table };
      options.writes?.push(write);
      return chain(insertResults.shift() ?? [], write);
    },
    update: (table: unknown) => {
      const write: DbWrite = { method: 'update', table };
      options.writes?.push(write);
      return chain(updateResults.shift() ?? [], write);
    },
  };
  return db as unknown as Deps['db'];
}

/** Every string reachable in a (possibly cyclic) drizzle SQL object. */
function collectStrings(value: unknown, seen = new Set<unknown>()): string[] {
  if (typeof value === 'string') {
    return [value];
  }
  if (value === null || typeof value !== 'object' || seen.has(value)) {
    return [];
  }
  seen.add(value);
  const children = Array.isArray(value)
    ? value
    : Object.values(value as Record<string, unknown>);
  const out: string[] = [];
  for (const child of children) {
    out.push(...collectStrings(child, seen));
  }
  return out;
}

const baseConfig = {
  INGEST_API_KEY: 'test-key',
  SOWER_ENV: 'test',
} as unknown as Config;

function createDeps(db: Deps['db']): Deps {
  return {
    db,
    queue: { enqueueProcess: async () => {} },
    config: baseConfig,
    logger: false,
  };
}

const TASK_ID = 'aaaaaaaa-0000-4000-8000-000000000001';
const FILL_ID = 'ffffffff-0000-4000-8000-000000000001';
const AUTH = { 'x-api-key': 'test-key' };

const questions = [
  { id: 'q-name', label: 'Full name', type: 'text', required: true },
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
      { label: 'Go', value: 'go' },
    ],
  },
  { id: 'q-resume', label: 'Resume', type: 'file', required: true },
  { id: 'q-cover', label: 'Cover letter', type: 'textarea', required: false },
  { id: 'q-extra', label: 'Anything else?', type: 'text', required: false },
];

const SPEC = {
  platform: 'greenhouse',
  tenant: 'acme',
  externalId: '1',
  title: 'Software Engineer Intern',
  applyUrl: 'https://boards.greenhouse.io/acme/jobs/1',
  questions,
};

const RESOLUTION = {
  resolved: [
    { questionId: 'q-name', source: 'profile', value: 'Ibraheem Amin' },
    { questionId: 'q-visa', source: 'bank', value: '0' },
    { questionId: 'q-langs', source: 'user', value: ['ts', 'go'] },
    { questionId: 'q-resume', source: 'document', value: 'docs/resume-v3.pdf' },
  ],
  // 'Cover letter' is stored missing, but the answers bank below holds it —
  // the payload must fall back to the banked savedInput. 'q-extra' is
  // neither resolved nor missing: unresolved, so unanswered.
  missing: [questions[4]],
};

/** The /tasks/:id/fill join row (only platform/state/jobSpec are read). */
function taskJoin(state = 'NEEDS_INPUT', platform = 'greenhouse') {
  return [
    {
      task: { id: TASK_ID, state, jobSpec: SPEC, resolution: RESOLUTION },
      job: {
        platform,
        company: 'Acme',
        title: 'Software Engineer Intern',
        url: 'https://boards.greenhouse.io/acme/jobs/1',
      },
    },
  ];
}

/**
 * The reads POST /tasks/:id/fill performs before it looks for an open job:
 * the resolution refresh pulls the profile, the answer bank and the stored
 * documents. Empty here, so the recompute resolves nothing and the refresh
 * discards it rather than overwriting RESOLUTION — see the guard test.
 */
const REFRESH_READS: unknown[][] = [[], [], []];

/** A fill_jobs row as the db returns it. */
function fillJobRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: FILL_ID,
    taskId: TASK_ID,
    status: 'requested',
    liveViewUrl: null,
    report: null,
    error: null,
    requestedAt: new Date('2026-08-28T12:00:00.000Z'),
    claimedAt: null,
    heartbeatAt: null,
    finishedAt: null,
    ...overrides,
  };
}

describe('POST /tasks/:id/fill', () => {
  it('requires the api key', async () => {
    const app = buildServer(createDeps(createFakeDb()));
    const response = await app.inject({
      method: 'POST',
      url: `/tasks/${TASK_ID}/fill`,
    });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it('400s on a malformed id', async () => {
    const app = buildServer(createDeps(createFakeDb()));
    const response = await app.inject({
      method: 'POST',
      url: '/tasks/not-a-uuid/fill',
      headers: AUTH,
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it('404s on an unknown task', async () => {
    const app = buildServer(createDeps(createFakeDb({ selectResults: [[]] })));
    const response = await app.inject({
      method: 'POST',
      url: `/tasks/${TASK_ID}/fill`,
      headers: AUTH,
    });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it('409s for a non-greenhouse task (v1)', async () => {
    const writes: DbWrite[] = [];
    const app = buildServer(
      createDeps(
        createFakeDb({
          selectResults: [taskJoin('NEEDS_INPUT', 'workday')],
          writes,
        }),
      ),
    );
    const response = await app.inject({
      method: 'POST',
      url: `/tasks/${TASK_ID}/fill`,
      headers: AUTH,
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toMatch(/greenhouse-only/);
    expect(writes).toEqual([]);
    await app.close();
  });

  it('409s for a task outside NEEDS_INPUT/REVIEW', async () => {
    const writes: DbWrite[] = [];
    const app = buildServer(
      createDeps(createFakeDb({ selectResults: [taskJoin('QUEUED')], writes })),
    );
    const response = await app.inject({
      method: 'POST',
      url: `/tasks/${TASK_ID}/fill`,
      headers: AUTH,
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toMatch(/state 'QUEUED'/);
    expect(writes).toEqual([]);
    await app.close();
  });

  it("409s with the active job when one is still 'requested'", async () => {
    const active = fillJobRow();
    const writes: DbWrite[] = [];
    const app = buildServer(
      createDeps(
        createFakeDb({
          selectResults: [taskJoin('REVIEW'), ...REFRESH_READS, [active]],
          writes,
        }),
      ),
    );
    const response = await app.inject({
      method: 'POST',
      url: `/tasks/${TASK_ID}/fill`,
      headers: AUTH,
    });
    expect(response.statusCode).toBe(409);
    const body = response.json();
    expect(body.error).toMatch(/already in progress/);
    expect(body.job).toMatchObject({ id: FILL_ID, status: 'requested' });
    expect(writes).toEqual([]);
    await app.close();
  });

  it('409s when a claimed job has a fresh heartbeat', async () => {
    const active = fillJobRow({
      status: 'running',
      claimedAt: new Date(Date.now() - 4 * 60_000),
      heartbeatAt: new Date(Date.now() - 60_000),
    });
    const app = buildServer(
      createDeps(
        createFakeDb({
          selectResults: [taskJoin(), ...REFRESH_READS, [active]],
        }),
      ),
    );
    const response = await app.inject({
      method: 'POST',
      url: `/tasks/${TASK_ID}/fill`,
      headers: AUTH,
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().job).toMatchObject({ id: FILL_ID });
    await app.close();
  });

  it('never lets a degraded recompute overwrite the stored resolution', async () => {
    // A fill refreshes the task's resolution first, so an answer saved since
    // the last pipeline run reaches the form. But an unreadable profile
    // resolves as the EMPTY profile instead of throwing, and persisting that
    // would wipe good answers off the task — a snapshot that answers fewer
    // questions than the stored one is discarded.
    const inserted = fillJobRow({ id: 'ffffffff-0000-4000-8000-000000000003' });
    const writes: DbWrite[] = [];
    const app = buildServer(
      createDeps(
        createFakeDb({
          selectResults: [taskJoin(), ...REFRESH_READS, []],
          insertResults: [[inserted], []],
          writes,
        }),
      ),
    );
    const response = await app.inject({
      method: 'POST',
      url: `/tasks/${TASK_ID}/fill`,
      headers: AUTH,
    });
    expect(response.statusCode).toBe(200);
    expect(
      writes.some(
        (write) =>
          write.method === 'update' && write.table === applicationTasks,
      ),
    ).toBe(false);
  });

  it('inserts a job + FILL_REQUESTED event despite a stale claimed job', async () => {
    const stale = fillJobRow({
      status: 'claimed',
      claimedAt: new Date(Date.now() - 30 * 60_000),
      heartbeatAt: new Date(Date.now() - 10 * 60_000),
    });
    const inserted = fillJobRow({
      id: 'ffffffff-0000-4000-8000-000000000002',
    });
    const writes: DbWrite[] = [];
    const app = buildServer(
      createDeps(
        createFakeDb({
          selectResults: [taskJoin(), ...REFRESH_READS, [stale]],
          insertResults: [[inserted], []],
          writes,
        }),
      ),
    );
    const response = await app.inject({
      method: 'POST',
      url: `/tasks/${TASK_ID}/fill`,
      headers: AUTH,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().job).toMatchObject({
      id: inserted.id,
      taskId: TASK_ID,
      status: 'requested',
    });
    expect(writes).toHaveLength(2);
    expect(writes[0]).toMatchObject({
      method: 'insert',
      table: fillJobs,
      arg: { taskId: TASK_ID },
    });
    expect(writes[1]).toMatchObject({
      method: 'insert',
      table: events,
      arg: {
        taskId: TASK_ID,
        type: 'FILL_REQUESTED',
        data: { jobId: inserted.id },
      },
    });
    await app.close();
  });
});

describe('POST /fill-jobs/claim', () => {
  it('answers {job: null} when nothing is pending (reap runs first)', async () => {
    const writes: DbWrite[] = [];
    const app = buildServer(
      createDeps(createFakeDb({ updateResults: [[], []], writes })),
    );
    const response = await app.inject({
      method: 'POST',
      url: '/fill-jobs/claim',
      headers: AUTH,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ job: null });
    // Reap first (failed + the canonical error), then the claim attempt.
    expect(writes).toHaveLength(2);
    expect(writes[0]).toMatchObject({
      method: 'update',
      table: fillJobs,
      arg: { status: 'failed', error: 'runner heartbeat lost' },
    });
    expect(writes[1]).toMatchObject({
      method: 'update',
      table: fillJobs,
      arg: { status: 'claimed' },
    });
    await app.close();
  });

  it('reaps stale claimed/running jobs with a FILL_FAILED event each', async () => {
    const writes: DbWrite[] = [];
    const app = buildServer(
      createDeps(
        createFakeDb({
          updateResults: [
            [
              { id: FILL_ID, taskId: TASK_ID },
              {
                id: 'ffffffff-0000-4000-8000-000000000002',
                taskId: 'aaaaaaaa-0000-4000-8000-000000000002',
              },
            ],
            [],
          ],
          insertResults: [[], []],
          writes,
        }),
      ),
    );
    const response = await app.inject({
      method: 'POST',
      url: '/fill-jobs/claim',
      headers: AUTH,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ job: null });
    const eventInserts = writes.filter((w) => w.table === events);
    expect(eventInserts.map((w) => w.arg)).toEqual([
      {
        taskId: TASK_ID,
        type: 'FILL_FAILED',
        data: { jobId: FILL_ID, error: 'runner heartbeat lost' },
      },
      {
        taskId: 'aaaaaaaa-0000-4000-8000-000000000002',
        type: 'FILL_FAILED',
        data: {
          jobId: 'ffffffff-0000-4000-8000-000000000002',
          error: 'runner heartbeat lost',
        },
      },
    ]);
    await app.close();
  });

  it('claims via FOR UPDATE SKIP LOCKED and returns the RAW-values payload', async () => {
    const claimed = fillJobRow({
      status: 'claimed',
      claimedAt: new Date(),
      heartbeatAt: new Date(),
    });
    const writes: DbWrite[] = [];
    const app = buildServer(
      createDeps(
        createFakeDb({
          updateResults: [[], [claimed]],
          selectResults: [
            taskJoin(),
            [
              {
                id: 'eeeeeeee-0000-4000-8000-000000000001',
                kind: 'resume',
                filename: 'resume-v3.pdf',
                storagePath: 'docs/resume-v3.pdf',
              },
            ],
            // Normalized label of 'Cover letter'; global scope.
            [
              {
                normalizedLabel: 'cover letter',
                value: 'I love building systems.',
                company: '',
              },
            ],
          ],
          writes,
        }),
      ),
    );
    const response = await app.inject({
      method: 'POST',
      url: '/fill-jobs/claim',
      headers: AUTH,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.job).toEqual({ id: FILL_ID, taskId: TASK_ID });

    // The claim races on the sessions-actions SKIP LOCKED idiom.
    const claimWrite = writes[1];
    expect(claimWrite?.arg).toMatchObject({ status: 'claimed' });
    expect(collectStrings(claimWrite?.where).join(' ')).toContain(
      'for update skip locked',
    );

    expect(body.payload.applyUrl).toBe(
      'https://boards.greenhouse.io/acme/jobs/1',
    );
    expect(body.payload.company).toBe('Acme');
    expect(body.payload.title).toBe('Software Engineer Intern');
    // RAW input values: the select's option VALUE (not its display label),
    // arrays as-is, the bank 'saved' fallback for stored-missing questions,
    // file + unanswered null.
    expect(body.payload.questions).toEqual([
      {
        id: 'q-name',
        label: 'Full name',
        type: 'text',
        required: true,
        options: [],
        values: ['Ibraheem Amin'],
      },
      {
        id: 'q-visa',
        label: 'Need sponsorship?',
        type: 'select',
        required: true,
        options: [
          { label: 'Yes', value: '1' },
          { label: 'No', value: '0' },
        ],
        values: ['0'],
      },
      {
        id: 'q-langs',
        label: 'Languages',
        type: 'multiselect',
        required: false,
        options: [
          { label: 'TypeScript', value: 'ts' },
          { label: 'Go', value: 'go' },
        ],
        values: ['ts', 'go'],
      },
      {
        id: 'q-resume',
        label: 'Resume',
        type: 'file',
        required: true,
        options: [],
        values: null,
      },
      {
        id: 'q-cover',
        label: 'Cover letter',
        type: 'textarea',
        required: false,
        options: [],
        values: ['I love building systems.'],
      },
      {
        id: 'q-extra',
        label: 'Anything else?',
        type: 'text',
        required: false,
        options: [],
        values: null,
      },
    ]);
    await app.close();
  });
});

describe('POST /fill-jobs/:id/report', () => {
  it('404s on an unknown job', async () => {
    const app = buildServer(createDeps(createFakeDb({ selectResults: [[]] })));
    const response = await app.inject({
      method: 'POST',
      url: `/fill-jobs/${FILL_ID}/report`,
      headers: AUTH,
      payload: { status: 'running' },
    });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it('accepts a failure detail as long as the runner may send', async () => {
    // The runner trims each failure to 600 characters (summarizeFailure,
    // which keeps both ends of a Playwright call log). A tighter cap here
    // rejected the whole report and lost a finished fill.
    for (const [length, expected] of [
      [600, 200],
      [601, 400],
    ] as const) {
      const row = fillJobRow({ status: 'running' });
      const app = buildServer(
        createDeps(
          createFakeDb({
            selectResults: [[row]],
            updateResults: [[{ ...row, status: 'ready' }]],
            insertResults: [[]],
          }),
        ),
      );
      const response = await app.inject({
        method: 'POST',
        url: `/fill-jobs/${FILL_ID}/report`,
        headers: AUTH,
        payload: {
          status: 'ready',
          report: [
            {
              questionId: 'q1',
              label: 'Q',
              outcome: 'failed',
              detail: 'x'.repeat(length),
            },
          ],
        },
      });
      expect(response.statusCode).toBe(expected);
      await app.close();
    }
  });

  it('409s unless the job is claimed/running', async () => {
    for (const status of ['requested', 'ready', 'failed']) {
      const app = buildServer(
        createDeps(createFakeDb({ selectResults: [[fillJobRow({ status })]] })),
      );
      const response = await app.inject({
        method: 'POST',
        url: `/fill-jobs/${FILL_ID}/report`,
        headers: AUTH,
        payload: { status: 'running' },
      });
      expect(response.statusCode).toBe(409);
      await app.close();
    }
  });

  it('400s on a non-http(s)/wss live-view URL', async () => {
    const app = buildServer(createDeps(createFakeDb()));
    const response = await app.inject({
      method: 'POST',
      url: `/fill-jobs/${FILL_ID}/report`,
      headers: AUTH,
      payload: { status: 'running', liveViewUrl: 'javascript:alert(1)' },
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("persists 'running' + the live-view URL without an event", async () => {
    const row = fillJobRow({ status: 'claimed', claimedAt: new Date() });
    const updated = {
      ...row,
      status: 'running',
      liveViewUrl: 'https://live.example/devtools/page/abc',
    };
    const writes: DbWrite[] = [];
    const app = buildServer(
      createDeps(
        createFakeDb({
          selectResults: [[row]],
          updateResults: [[updated]],
          writes,
        }),
      ),
    );
    const response = await app.inject({
      method: 'POST',
      url: `/fill-jobs/${FILL_ID}/report`,
      headers: AUTH,
      payload: {
        status: 'running',
        liveViewUrl: 'https://live.example/devtools/page/abc',
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().job).toMatchObject({
      id: FILL_ID,
      status: 'running',
      liveViewUrl: 'https://live.example/devtools/page/abc',
    });
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      method: 'update',
      table: fillJobs,
      arg: {
        status: 'running',
        liveViewUrl: 'https://live.example/devtools/page/abc',
      },
    });
    expect(writes[0]?.arg).not.toHaveProperty('finishedAt');
    await app.close();
  });

  it("'ready' sets finished_at + the report and appends FILL_READY", async () => {
    const row = fillJobRow({
      status: 'running',
      claimedAt: new Date(),
      heartbeatAt: new Date(),
      liveViewUrl: 'https://live.example/devtools/page/abc',
    });
    const report = [
      { questionId: 'q-name', label: 'Full name', outcome: 'filled' },
      {
        questionId: 'q-resume',
        label: 'Resume',
        outcome: 'skipped',
        detail: 'attach manually in the live view',
      },
    ];
    const updated = { ...row, status: 'ready', report };
    const writes: DbWrite[] = [];
    const app = buildServer(
      createDeps(
        createFakeDb({
          selectResults: [[row]],
          updateResults: [[updated]],
          insertResults: [[]],
          writes,
        }),
      ),
    );
    const response = await app.inject({
      method: 'POST',
      url: `/fill-jobs/${FILL_ID}/report`,
      headers: AUTH,
      payload: { status: 'ready', report },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().job).toMatchObject({ status: 'ready' });
    expect(writes[0]).toMatchObject({
      method: 'update',
      table: fillJobs,
      arg: { status: 'ready', report },
    });
    const readySet = writes[0]?.arg as { finishedAt: unknown };
    expect(readySet.finishedAt).toBeInstanceOf(Date);
    // FILL_READY carries the effective live-view URL — the stored one when
    // the ready report omits it.
    expect(writes[1]).toMatchObject({
      method: 'insert',
      table: events,
      arg: {
        taskId: TASK_ID,
        type: 'FILL_READY',
        data: {
          jobId: FILL_ID,
          liveViewUrl: 'https://live.example/devtools/page/abc',
        },
      },
    });
    await app.close();
  });

  it('accepts a report entry with an empty label', async () => {
    // The claim payload can legitimately carry an empty label; the runner
    // echoes it back, and a successful fill must not 400 its own report.
    const row = fillJobRow({ status: 'running', claimedAt: new Date() });
    const report = [{ questionId: 'q-blank', label: '', outcome: 'filled' }];
    const updated = { ...row, status: 'ready', report };
    const app = buildServer(
      createDeps(
        createFakeDb({
          selectResults: [[row]],
          updateResults: [[updated]],
          insertResults: [[]],
        }),
      ),
    );
    const response = await app.inject({
      method: 'POST',
      url: `/fill-jobs/${FILL_ID}/report`,
      headers: AUTH,
      payload: { status: 'ready', report },
    });
    expect(response.statusCode).toBe(200);
    await app.close();
  });
});

describe('POST /fill-jobs/:id/fail', () => {
  it('404s on an unknown job', async () => {
    const app = buildServer(createDeps(createFakeDb({ selectResults: [[]] })));
    const response = await app.inject({
      method: 'POST',
      url: `/fill-jobs/${FILL_ID}/fail`,
      headers: AUTH,
      payload: { error: 'boom' },
    });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it('409s unless the job is claimed/running', async () => {
    for (const status of ['requested', 'ready', 'failed']) {
      const writes: DbWrite[] = [];
      const app = buildServer(
        createDeps(
          createFakeDb({ selectResults: [[fillJobRow({ status })]], writes }),
        ),
      );
      const response = await app.inject({
        method: 'POST',
        url: `/fill-jobs/${FILL_ID}/fail`,
        headers: AUTH,
        payload: { error: 'boom' },
      });
      expect(response.statusCode).toBe(409);
      expect(writes).toEqual([]);
      await app.close();
    }
  });

  it('marks the job failed with finished_at and appends FILL_FAILED', async () => {
    const row = fillJobRow({ status: 'running', claimedAt: new Date() });
    const updated = { ...row, status: 'failed', error: 'form not found' };
    const writes: DbWrite[] = [];
    const app = buildServer(
      createDeps(
        createFakeDb({
          selectResults: [[row]],
          updateResults: [[updated]],
          insertResults: [[]],
          writes,
        }),
      ),
    );
    const response = await app.inject({
      method: 'POST',
      url: `/fill-jobs/${FILL_ID}/fail`,
      headers: AUTH,
      payload: { error: 'form not found' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().job).toMatchObject({
      status: 'failed',
      error: 'form not found',
    });
    expect(writes[0]).toMatchObject({
      method: 'update',
      table: fillJobs,
      arg: { status: 'failed', error: 'form not found' },
    });
    const failSet = writes[0]?.arg as { finishedAt: unknown };
    expect(failSet.finishedAt).toBeInstanceOf(Date);
    expect(writes[1]).toMatchObject({
      method: 'insert',
      table: events,
      arg: {
        taskId: TASK_ID,
        type: 'FILL_FAILED',
        data: { jobId: FILL_ID, error: 'form not found' },
      },
    });
    await app.close();
  });
});

describe('POST /fill-jobs/:id/heartbeat', () => {
  it('404s on an unknown job', async () => {
    const app = buildServer(createDeps(createFakeDb({ selectResults: [[]] })));
    const response = await app.inject({
      method: 'POST',
      url: `/fill-jobs/${FILL_ID}/heartbeat`,
      headers: AUTH,
    });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it('409s unless the job is claimed/running', async () => {
    const app = buildServer(
      createDeps(createFakeDb({ selectResults: [[{ status: 'ready' }]] })),
    );
    const response = await app.inject({
      method: 'POST',
      url: `/fill-jobs/${FILL_ID}/heartbeat`,
      headers: AUTH,
    });
    expect(response.statusCode).toBe(409);
    await app.close();
  });

  it('bumps heartbeat_at for a working job', async () => {
    const writes: DbWrite[] = [];
    const app = buildServer(
      createDeps(
        createFakeDb({
          selectResults: [[{ status: 'running' }]],
          updateResults: [[]],
          writes,
        }),
      ),
    );
    const response = await app.inject({
      method: 'POST',
      url: `/fill-jobs/${FILL_ID}/heartbeat`,
      headers: AUTH,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    expect(writes[0]).toMatchObject({ method: 'update', table: fillJobs });
    const heartbeatSet = writes[0]?.arg as { heartbeatAt: unknown };
    expect(heartbeatSet.heartbeatAt).toBeInstanceOf(Date);
    await app.close();
  });
});

describe('fillTargetUrl', () => {
  const spec = {
    ...SPEC,
    tenant: 'jumptrading',
    externalId: '8007788',
  } as JobSpec;

  it('fills a greenhouse-hosted posting where it lives', () => {
    const hosted = 'https://job-boards.greenhouse.io/acme/jobs/1';
    expect(fillTargetUrl(spec, hosted)).toBe(hosted);
    expect(
      fillTargetUrl(spec, 'https://boards.greenhouse.io/acme/jobs/1'),
    ).toBe('https://boards.greenhouse.io/acme/jobs/1');
  });

  it('opens an embedded posting on the greenhouse embed page instead', () => {
    // The company page wraps the form in a cross-origin iframe (or renders
    // its own); the embed endpoint IS that form, addressed by tenant + id.
    expect(
      fillTargetUrl(spec, 'https://www.jumptrading.com/hr/job?gh_jid=8007788'),
    ).toBe(
      'https://job-boards.greenhouse.io/embed/job_app?for=jumptrading&token=8007788',
    );
  });

  it('falls back to the apply url when the spec cannot name the board', () => {
    const anonymous: JobSpec = { ...spec, tenant: '', externalId: '' };
    const url = 'https://stripe.com/jobs/search?gh_jid=8128745';
    expect(fillTargetUrl(anonymous, url)).toBe(url);
    expect(fillTargetUrl(null, url)).toBe(url);
    expect(fillTargetUrl(spec, 'not a url')).toBe('not a url');
  });
});
