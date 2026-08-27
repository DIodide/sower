import { describe, expect, it } from 'vitest';
import type { Config } from './config.js';
import { buildServer } from './server.js';
import type { Deps } from './types.js';

/**
 * /cli read-only routes against a fake db: the second accepted api key
 * (CLI_API_KEY beside INGEST_API_KEY), the list's shapes (identity
 * fallback, effective deadline, questionCount, grouped open-follow-up
 * counts), the detail's extras over the mobile shape (jobNotes with
 * question labels, follow-up sourceBody, the answers-bank 'saved' question
 * status), and the export's fixed batched-query count — the fake db hands
 * out ONE result set per select, so a per-task N+1 would run out of rows
 * and fail loudly. The db fake throws on any write: these routes must
 * never write.
 */

interface Chain {
  from: () => Chain;
  where: (condition?: unknown) => Chain;
  limit: () => Chain;
  innerJoin: () => Chain;
  orderBy: () => Chain;
  groupBy: () => Chain;
  then: (onFulfilled: (value: unknown) => unknown) => Promise<unknown>;
}

function chain(result: unknown, onWhere?: (arg: unknown) => void): Chain {
  const self: Chain = {
    from: () => self,
    where: (condition?: unknown) => {
      onWhere?.(condition);
      return self;
    },
    limit: () => self,
    innerJoin: () => self,
    orderBy: () => self,
    groupBy: () => self,
    // biome-ignore lint/suspicious/noThenProperty: intentionally thenable to mimic drizzle's awaitable query builder
    then: (onFulfilled) => Promise.resolve(result).then(onFulfilled),
  };
  return self;
}

function createFakeDb(
  selectResults: unknown[][] = [],
  /** When provided, every select's where() argument is recorded here. */
  wheres?: unknown[],
): Deps['db'] {
  const results = [...selectResults];
  const db = {
    select: () => {
      const next = results.shift();
      if (next === undefined) {
        throw new Error('cli routes ran more queries than the test provided');
      }
      return chain(next, (arg) => wheres?.push(arg));
    },
    insert: () => {
      throw new Error('cli routes must never write');
    },
    update: () => {
      throw new Error('cli routes must never write');
    },
    delete: () => {
      throw new Error('cli routes must never write');
    },
  };
  return db as unknown as Deps['db'];
}

const baseConfig = {
  INGEST_API_KEY: 'ingest-key',
  CLI_API_KEY: 'cli-key',
  SOWER_ENV: 'test',
} as unknown as Config;

function createDeps(db: Deps['db'], config: Config = baseConfig): Deps {
  return {
    db,
    queue: { enqueueProcess: async () => {} },
    config,
    logger: false,
  };
}

const TASK_ID = 'aaaaaaaa-0000-4000-8000-000000000001';
const JOB_ID = 'cccccccc-0000-4000-8000-000000000001';
const FOLLOWUP_ID = 'bbbbbbbb-0000-4000-8000-000000000001';
const NOTE_ID = 'dddddddd-0000-4000-8000-000000000001';
const AUTH = { 'x-api-key': 'cli-key' };

/** A listSelection row (task + joined job) as the db returns it. */
function listRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: TASK_ID,
    state: 'NEEDS_INPUT',
    priority: 1,
    dueDate: null,
    jobSpec: {
      platform: 'greenhouse',
      tenant: 'acme',
      externalId: '1',
      title: 'Software Engineer Intern',
      applyUrl: 'https://boards.greenhouse.io/acme/jobs/1',
      questions: [
        { id: 'q1', label: 'Full name', type: 'text', required: true },
        { id: 'q2', label: 'Why here?', type: 'textarea', required: false },
      ],
    },
    notes: 'my note',
    createdAt: new Date('2026-07-01T12:00:00.000Z'),
    updatedAt: new Date('2026-08-01T12:00:00.000Z'),
    company: 'Acme',
    title: 'Software Engineer Intern',
    url: 'https://boards.greenhouse.io/acme/jobs/1',
    platform: 'greenhouse',
    source: 'manual',
    deadline: new Date('2026-08-20T00:00:00.000Z'),
    ...overrides,
  };
}

describe('cli auth', () => {
  it('rejects a missing key', async () => {
    const app = buildServer(createDeps(createFakeDb()));
    const response = await app.inject({ method: 'GET', url: '/cli/tasks' });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it('rejects a wrong key without leaking either accepted key', async () => {
    const app = buildServer(createDeps(createFakeDb()));
    const response = await app.inject({
      method: 'GET',
      url: '/cli/tasks',
      headers: { 'x-api-key': 'nope' },
    });
    expect(response.statusCode).toBe(401);
    expect(response.body).not.toContain('ingest-key');
    expect(response.body).not.toContain('cli-key');
    await app.close();
  });

  it('accepts the CLI key on any guarded route, and the ingest key on /cli', async () => {
    // CLI key on a non-/cli route: the preHandler is server-wide.
    const app = buildServer(createDeps(createFakeDb([[], []])));
    const viaCli = await app.inject({
      method: 'GET',
      url: '/tasks',
      headers: AUTH,
    });
    expect(viaCli.statusCode).toBe(200);
    await app.close();

    const app2 = buildServer(createDeps(createFakeDb([[], []])));
    const viaIngest = await app2.inject({
      method: 'GET',
      url: '/cli/tasks',
      headers: { 'x-api-key': 'ingest-key' },
    });
    expect(viaIngest.statusCode).toBe(200);
    await app2.close();
  });

  it('never accepts the CLI key when CLI_API_KEY is unset', async () => {
    const config = {
      INGEST_API_KEY: 'ingest-key',
      SOWER_ENV: 'test',
    } as unknown as Config;
    const app = buildServer(createDeps(createFakeDb(), config));
    const response = await app.inject({
      method: 'GET',
      url: '/cli/tasks',
      headers: AUTH,
    });
    expect(response.statusCode).toBe(401);
    await app.close();
  });
});

describe('GET /cli/tasks', () => {
  it('returns list items with identity fallback, effective deadline, questionCount, and grouped open-follow-up counts', async () => {
    const rows = [
      listRow(),
      // No jobs identity → jobSpec fallback; user due date beats deadline;
      // no spec questions → questionCount 0.
      listRow({
        id: 'aaaaaaaa-0000-4000-8000-000000000002',
        state: 'DISCARDED',
        priority: 0,
        company: null,
        title: null,
        jobSpec: { company: 'SpecCo', title: 'Spec Role' },
        dueDate: new Date('2026-08-08T04:00:00.000Z'),
        notes: null,
      }),
    ];
    const openCounts = [{ taskId: TASK_ID, n: 2 }];
    const db = createFakeDb([rows, openCounts]);
    const app = buildServer(createDeps(db));
    const response = await app.inject({
      method: 'GET',
      url: '/cli/tasks',
      headers: AUTH,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.tasks).toEqual([
      {
        id: TASK_ID,
        company: 'Acme',
        title: 'Software Engineer Intern',
        state: 'NEEDS_INPUT',
        priority: 1,
        priorityLabel: 'High',
        dueDate: '2026-08-20T00:00:00.000Z',
        url: 'https://boards.greenhouse.io/acme/jobs/1',
        platform: 'greenhouse',
        source: 'manual',
        notes: 'my note',
        createdAt: '2026-07-01T12:00:00.000Z',
        updatedAt: '2026-08-01T12:00:00.000Z',
        questionCount: 2,
        openFollowups: 2,
      },
      {
        id: 'aaaaaaaa-0000-4000-8000-000000000002',
        company: 'SpecCo',
        title: 'Spec Role',
        state: 'DISCARDED',
        priority: 0,
        priorityLabel: 'Normal',
        dueDate: '2026-08-08T04:00:00.000Z',
        url: 'https://boards.greenhouse.io/acme/jobs/1',
        platform: 'greenhouse',
        source: 'manual',
        notes: null,
        createdAt: '2026-07-01T12:00:00.000Z',
        updatedAt: '2026-08-01T12:00:00.000Z',
        questionCount: 0,
        openFollowups: 0,
      },
    ]);
    await app.close();
  });

  it('accepts a comma state filter and 400s an unknown state', async () => {
    const okApp = buildServer(createDeps(createFakeDb([[], []])));
    const ok = await okApp.inject({
      method: 'GET',
      url: '/cli/tasks?state=NEEDS_INPUT,REVIEW&limit=10',
      headers: AUTH,
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ tasks: [] });
    await okApp.close();

    const badApp = buildServer(createDeps(createFakeDb()));
    const bad = await badApp.inject({
      method: 'GET',
      url: '/cli/tasks?state=NEEDS_INPUT,NOPE',
      headers: AUTH,
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe("invalid state 'NOPE'");
    expect(bad.json().allowed).toContain('DISCARDED');
    await badApp.close();
  });

  it('?q= adds the dashboard search condition (and blank q adds none)', async () => {
    const wheres: unknown[] = [];
    const app = buildServer(
      createDeps(createFakeDb([[listRow()], []], wheres)),
    );
    const res = await app.inject({
      method: 'GET',
      url: '/cli/tasks?q=acme',
      headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().tasks).toHaveLength(1);
    // The list select carries a condition; the grouped follow-up count
    // select keeps its own open-states filter.
    expect(wheres[0]).toBeDefined();
    await app.close();

    const blank: unknown[] = [];
    const app2 = buildServer(createDeps(createFakeDb([[], []], blank)));
    expect(
      (
        await app2.inject({
          method: 'GET',
          url: '/cli/tasks?q=',
          headers: AUTH,
        })
      ).statusCode,
    ).toBe(200);
    // No state, no search → the list select is unfiltered.
    expect(blank[0]).toBeUndefined();
    await app2.close();

    const tooLong = buildServer(createDeps(createFakeDb()));
    expect(
      (
        await tooLong.inject({
          method: 'GET',
          url: `/cli/tasks?q=${'x'.repeat(201)}`,
          headers: AUTH,
        })
      ).statusCode,
    ).toBe(400);
    await tooLong.close();
  });

  it('400s a limit above the cap', async () => {
    const app = buildServer(createDeps(createFakeDb()));
    const response = await app.inject({
      method: 'GET',
      url: '/cli/tasks?limit=2001',
      headers: AUTH,
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });
});

/** The task+job detail row and its per-table companions, in fetch order. */
function detailResultSets() {
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
      id: 'q-cover',
      label: 'Cover letter',
      type: 'textarea',
      required: false,
      limit: { kind: 'characters', max: 500 },
    },
    { id: 'q-extra', label: 'Anything else?', type: 'text', required: false },
  ];
  const task = {
    id: TASK_ID,
    jobId: JOB_ID,
    state: 'NEEDS_INPUT',
    priority: 1,
    notes: 'ping the recruiter',
    dueDate: null,
    jobSpec: {
      platform: 'greenhouse',
      tenant: 'acme',
      externalId: '1',
      title: 'Software Engineer Intern',
      applyUrl: 'https://boards.greenhouse.io/acme/jobs/1',
      questions,
    },
    resolution: {
      resolved: [
        { questionId: 'q-name', source: 'profile', value: 'Ibraheem Amin' },
        { questionId: 'q-visa', source: 'bank', value: '0' },
      ],
      // 'Cover letter' is stored missing, but the answers bank below holds
      // it → the detail must surface 'saved' (dashboard parity).
      missing: [questions[2]],
    },
    createdAt: new Date('2026-07-01T12:00:00.000Z'),
    updatedAt: new Date('2026-08-01T12:00:00.000Z'),
  };
  const job = {
    id: JOB_ID,
    company: 'Acme',
    title: 'Software Engineer Intern',
    url: 'https://boards.greenhouse.io/acme/jobs/1',
    deadline: new Date('2026-08-20T00:00:00.000Z'),
  };
  return {
    taskAndJob: [{ task, job }],
    descriptions: [{ content: '## About the role' }],
    documents: [
      {
        id: 'eeeeeeee-0000-4000-8000-000000000001',
        kind: 'resume',
        filename: 'resume-v3.pdf',
        storagePath: 'docs/resume-v3.pdf',
      },
    ],
    followups: [
      {
        id: FOLLOWUP_ID,
        taskId: TASK_ID,
        kind: 'recruiter',
        title: 'Recruiter reply',
        state: 'WAITING',
        dueDate: null,
        url: 'https://cal.example.com/chat',
        notes: 'ask about the team',
        sourceBody: 'From: recruiter@acme.com\n\nHello!',
      },
    ],
    // taskId rides along so the SAME sets serve the export's batched
    // queries (the detail route simply ignores it).
    events: [
      {
        taskId: TASK_ID,
        type: 'FORM_DISCOVERED',
        createdAt: new Date('2026-08-01T12:00:00.000Z'),
        data: { questionCount: 4 },
      },
    ],
    jobNotes: [
      {
        taskId: TASK_ID,
        id: NOTE_ID,
        body: 'They value TypeScript heavily.',
        questionId: 'q-cover',
        createdAt: new Date('2026-07-02T12:00:00.000Z'),
      },
      {
        taskId: TASK_ID,
        id: 'dddddddd-0000-4000-8000-000000000002',
        body: 'General note.',
        questionId: null,
        createdAt: new Date('2026-07-03T12:00:00.000Z'),
      },
    ],
    // Normalized label of 'Cover letter'; global scope.
    bank: [
      {
        normalizedLabel: 'cover letter',
        value: 'I love building systems.',
        company: '',
      },
    ],
  };
}

/** What the detail (and each export entry) must look like for those rows. */
function expectedDetail() {
  return {
    task: {
      id: TASK_ID,
      state: 'NEEDS_INPUT',
      priority: 1,
      priorityLabel: 'High',
      dueDate: '2026-08-20T00:00:00.000Z',
      notes: 'ping the recruiter',
      url: 'https://boards.greenhouse.io/acme/jobs/1',
      company: 'Acme',
      title: 'Software Engineer Intern',
      createdAt: '2026-07-01T12:00:00.000Z',
      updatedAt: '2026-08-01T12:00:00.000Z',
    },
    description: '## About the role',
    questions: [
      {
        id: 'q-name',
        label: 'Full name',
        type: 'text',
        required: true,
        status: 'resolved',
        value: 'Ibraheem Amin',
        source: 'profile',
      },
      {
        id: 'q-visa',
        label: 'Need sponsorship?',
        type: 'select',
        required: true,
        status: 'resolved',
        value: 'No',
        source: 'bank',
      },
      {
        id: 'q-cover',
        label: 'Cover letter',
        type: 'textarea',
        required: false,
        limit: { kind: 'characters', max: 500 },
        status: 'saved',
        value: null,
        source: null,
        savedValues: ['I love building systems.'],
        savedInput: ['I love building systems.'],
      },
      {
        id: 'q-extra',
        label: 'Anything else?',
        type: 'text',
        required: false,
        status: 'unresolved',
        value: null,
        source: null,
      },
    ],
    followups: [
      {
        id: FOLLOWUP_ID,
        taskId: TASK_ID,
        kind: 'recruiter',
        kindLabel: 'Recruiter',
        title: 'Recruiter reply',
        state: 'WAITING',
        stateLabel: 'Waiting',
        dueDate: null,
        company: 'Acme',
        url: 'https://cal.example.com/chat',
        notes: 'ask about the team',
        sourceBody: 'From: recruiter@acme.com\n\nHello!',
      },
    ],
    jobNotes: [
      {
        id: NOTE_ID,
        body: 'They value TypeScript heavily.',
        questionId: 'q-cover',
        questionLabel: 'Cover letter',
        createdAt: '2026-07-02T12:00:00.000Z',
      },
      {
        id: 'dddddddd-0000-4000-8000-000000000002',
        body: 'General note.',
        questionId: null,
        questionLabel: null,
        createdAt: '2026-07-03T12:00:00.000Z',
      },
    ],
    timeline: [
      {
        type: 'FORM_DISCOVERED',
        at: '2026-08-01T12:00:00.000Z',
        summary: 'Form discovered — 4 questions',
      },
    ],
  };
}

describe('GET /cli/tasks/:id', () => {
  it('404s on an unknown task', async () => {
    const app = buildServer(createDeps(createFakeDb([[]])));
    const response = await app.inject({
      method: 'GET',
      url: `/cli/tasks/${TASK_ID}`,
      headers: AUTH,
    });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it('400s on a malformed id', async () => {
    const app = buildServer(createDeps(createFakeDb()));
    const response = await app.inject({
      method: 'GET',
      url: '/cli/tasks/not-a-uuid',
      headers: AUTH,
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it('returns the mobile detail plus jobNotes, follow-up bodies, and the saved question status', async () => {
    const sets = detailResultSets();
    const db = createFakeDb([
      sets.taskAndJob,
      sets.descriptions,
      sets.documents,
      sets.followups,
      sets.events,
      sets.jobNotes,
      sets.bank,
    ]);
    const app = buildServer(createDeps(db));
    const response = await app.inject({
      method: 'GET',
      url: `/cli/tasks/${TASK_ID}`,
      headers: AUTH,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(expectedDetail());
    await app.close();
  });
});

describe('GET /cli/export', () => {
  it('exports every task in the full detail shape from a FIXED number of batched queries', async () => {
    const sets = detailResultSets();
    const secondTask = {
      task: {
        id: 'aaaaaaaa-0000-4000-8000-000000000002',
        jobId: 'cccccccc-0000-4000-8000-000000000002',
        state: 'SUBMITTED',
        priority: 0,
        notes: null,
        dueDate: null,
        jobSpec: null,
        resolution: null,
        createdAt: null,
        updatedAt: null,
      },
      job: {
        id: 'cccccccc-0000-4000-8000-000000000002',
        company: null,
        title: null,
        url: 'https://www.example.com/careers/42',
        deadline: null,
      },
    };
    // EXACTLY seven result sets for two tasks: the fake db throws on any
    // query beyond these, so a per-task N+1 fails this test loudly.
    const db = createFakeDb([
      [...sets.taskAndJob, secondTask],
      [{ jobId: JOB_ID, content: '## About the role' }],
      sets.documents,
      sets.followups,
      sets.events,
      sets.jobNotes,
      sets.bank,
    ]);
    const app = buildServer(createDeps(db));
    const response = await app.inject({
      method: 'GET',
      url: '/cli/export',
      headers: AUTH,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(typeof body.generatedAt).toBe('string');
    expect(body.tasks).toHaveLength(2);
    expect(body.tasks[0]).toEqual(expectedDetail());
    // The specless task: URL-host identity fallback, empty collections.
    expect(body.tasks[1]).toEqual({
      task: {
        id: 'aaaaaaaa-0000-4000-8000-000000000002',
        state: 'SUBMITTED',
        priority: 0,
        priorityLabel: 'Normal',
        dueDate: null,
        notes: null,
        url: 'https://www.example.com/careers/42',
        company: 'example.com',
        title: null,
        createdAt: null,
        updatedAt: null,
      },
      description: null,
      questions: [],
      followups: [],
      jobNotes: [],
      timeline: [],
    });
    await app.close();
  });

  it('400s an unknown state filter', async () => {
    const app = buildServer(createDeps(createFakeDb()));
    const response = await app.inject({
      method: 'GET',
      url: '/cli/export?state=BOGUS',
      headers: AUTH,
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });
});
