import { describe, expect, it } from 'vitest';
import type { Config } from './config.js';
import { buildServer } from './server.js';
import type { Deps } from './types.js';

/**
 * /mobile read-only routes against a fake db: the overview's card shapes
 * (identity fallback jobs row → jobSpec → URL host, effective-deadline
 * precedence, per-task open-follow-up counts, follow-up labels), the task
 * detail's resolved/missing/unresolved question rendering and timeline
 * summaries, the follow-up detail join, and 404s. SQL ordering/caps are
 * delegated to the query builders (waitingOrderBy is proven in rank.test.ts);
 * here the responses must preserve the db's row order.
 */

interface Chain {
  from: () => Chain;
  where: () => Chain;
  limit: () => Chain;
  innerJoin: () => Chain;
  orderBy: () => Chain;
  then: (onFulfilled: (value: unknown) => unknown) => Promise<unknown>;
}

function chain(result: unknown): Chain {
  const self: Chain = {
    from: () => self,
    where: () => self,
    limit: () => self,
    innerJoin: () => self,
    orderBy: () => self,
    // biome-ignore lint/suspicious/noThenProperty: intentionally thenable to mimic drizzle's awaitable query builder
    then: (onFulfilled) => Promise.resolve(result).then(onFulfilled),
  };
  return self;
}

function createFakeDb(selectResults: unknown[][] = []): Deps['db'] {
  const results = [...selectResults];
  const db = {
    select: () => chain(results.shift() ?? []),
    insert: () => {
      throw new Error('mobile routes must never write');
    },
    update: () => {
      throw new Error('mobile routes must never write');
    },
  };
  return db as unknown as Deps['db'];
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
const SENT_TASK_ID = 'aaaaaaaa-0000-4000-8000-000000000002';
const FOLLOWUP_ID = 'bbbbbbbb-0000-4000-8000-000000000001';
const AUTH = { 'x-api-key': 'test-key' };

/** A cardSelection row (task + joined job) as the db returns it. */
function cardRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: TASK_ID,
    state: 'NEEDS_INPUT',
    priority: 0,
    dueDate: null,
    jobSpec: null,
    company: 'Acme',
    title: 'Software Engineer Intern',
    url: 'https://boards.greenhouse.io/acme/jobs/1',
    deadline: null,
    ...overrides,
  };
}

/** An "In play" join row (followup + parent job identity). */
function inPlayRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: FOLLOWUP_ID,
    taskId: SENT_TASK_ID,
    kind: 'assessment',
    title: 'Assessment — HackerRank invite',
    state: 'ACTION_NEEDED',
    dueDate: new Date('2026-08-10T04:00:00.000Z'),
    company: 'Acme',
    jobSpec: null,
    ...overrides,
  };
}

describe('GET /mobile/overview', () => {
  it('requires the api key', async () => {
    const app = buildServer(createDeps(createFakeDb()));
    const response = await app.inject({
      method: 'GET',
      url: '/mobile/overview',
    });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it('returns waiting/processing/inPlay/sent with fallbacks, effective deadlines, labels, and open-follow-up counts', async () => {
    const waiting = [
      // Full jobs-row identity; posting deadline is the effective date.
      cardRow({
        priority: 2,
        deadline: new Date('2026-08-20T00:00:00.000Z'),
      }),
      // No jobs identity: falls back to the discovered jobSpec; the user's
      // own due date wins over the posting deadline.
      cardRow({
        id: 'aaaaaaaa-0000-4000-8000-000000000003',
        state: 'REVIEW',
        priority: -1,
        company: null,
        title: null,
        jobSpec: { company: 'SpecCo', title: 'Spec Role' },
        dueDate: new Date('2026-08-08T04:00:00.000Z'),
        deadline: new Date('2026-08-20T00:00:00.000Z'),
      }),
      // No identity anywhere: the URL host (www. stripped) stands in.
      cardRow({
        id: 'aaaaaaaa-0000-4000-8000-000000000004',
        company: null,
        title: null,
        url: 'https://www.example.com/careers/42',
      }),
    ];
    const sent = [
      cardRow({
        id: SENT_TASK_ID,
        state: 'SUBMITTED',
        priority: 1,
      }),
    ];
    const db = createFakeDb([
      waiting,
      [{ n: 4 }],
      [
        inPlayRow(),
        inPlayRow({
          id: 'bbbbbbbb-0000-4000-8000-000000000002',
          kind: 'interview',
          state: 'RECEIVED',
          dueDate: null,
          company: null,
          jobSpec: { company: 'SpecCo' },
        }),
      ],
      sent,
    ]);
    const app = buildServer(createDeps(db));
    const response = await app.inject({
      method: 'GET',
      url: '/mobile/overview',
      headers: AUTH,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();

    expect(body.processing).toEqual({ count: 4 });

    // Waiting preserves the db's (waitingOrderBy) order.
    expect(body.waiting.map((c: { id: string }) => c.id)).toEqual(
      waiting.map((r) => r.id),
    );
    expect(body.waiting[0]).toEqual({
      id: TASK_ID,
      company: 'Acme',
      title: 'Software Engineer Intern',
      state: 'NEEDS_INPUT',
      priority: 2,
      priorityLabel: 'Highest',
      dueDate: '2026-08-20T00:00:00.000Z',
      url: 'https://boards.greenhouse.io/acme/jobs/1',
      openFollowups: 0,
    });
    // jobSpec fallback + user due date beating the posting deadline.
    expect(body.waiting[1]).toMatchObject({
      company: 'SpecCo',
      title: 'Spec Role',
      priorityLabel: 'Low',
      dueDate: '2026-08-08T04:00:00.000Z',
    });
    // URL-host fallback, as pieces (never a pre-joined label).
    expect(body.waiting[2]).toMatchObject({
      company: 'example.com',
      title: null,
      dueDate: null,
    });

    expect(body.inPlay).toEqual([
      {
        id: FOLLOWUP_ID,
        taskId: SENT_TASK_ID,
        kind: 'assessment',
        kindLabel: 'Assessment',
        title: 'Assessment — HackerRank invite',
        state: 'ACTION_NEEDED',
        stateLabel: 'Action needed',
        dueDate: '2026-08-10T04:00:00.000Z',
        company: 'Acme',
      },
      {
        id: 'bbbbbbbb-0000-4000-8000-000000000002',
        taskId: SENT_TASK_ID,
        kind: 'interview',
        kindLabel: 'Interview',
        title: 'Assessment — HackerRank invite',
        state: 'RECEIVED',
        stateLabel: 'Received',
        dueDate: null,
        company: 'SpecCo',
      },
    ]);

    // The sent card's count comes from the same open-follow-ups fetch.
    expect(body.sent).toHaveLength(1);
    expect(body.sent[0]).toMatchObject({
      id: SENT_TASK_ID,
      state: 'SUBMITTED',
      priorityLabel: 'High',
      openFollowups: 2,
    });
    await app.close();
  });
});

describe('GET /mobile/tasks/:id', () => {
  it('404s on an unknown task', async () => {
    const app = buildServer(createDeps(createFakeDb([[]])));
    const response = await app.inject({
      method: 'GET',
      url: `/mobile/tasks/${TASK_ID}`,
      headers: AUTH,
    });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it('400s on a malformed id', async () => {
    const app = buildServer(createDeps(createFakeDb()));
    const response = await app.inject({
      method: 'GET',
      url: '/mobile/tasks/not-a-uuid',
      headers: AUTH,
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it('returns the task, latest description, rendered questions, followups, and timeline summaries', async () => {
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
      { id: 'q-resume', label: 'Resume', type: 'file', required: true },
      {
        id: 'q-langs',
        label: 'Languages',
        type: 'multiselect',
        required: false,
      },
      {
        id: 'q-cover',
        label: 'Cover letter',
        type: 'textarea',
        required: false,
        // Source-declared cap — must pass through to the mobile payload.
        limit: { kind: 'characters', max: 500 },
      },
      { id: 'q-extra', label: 'Anything else?', type: 'text', required: false },
    ];
    const task = {
      id: TASK_ID,
      jobId: 'cccccccc-0000-4000-8000-000000000001',
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
          {
            questionId: 'q-resume',
            source: 'document',
            value: 'docs/resume-v3.pdf',
          },
          {
            questionId: 'q-langs',
            source: 'user',
            value: ['TypeScript', 'Go'],
          },
        ],
        missing: [questions[4]],
      },
      createdAt: new Date('2026-07-01T12:00:00.000Z'),
      updatedAt: new Date('2026-08-01T12:00:00.000Z'),
    };
    const job = {
      id: 'cccccccc-0000-4000-8000-000000000001',
      company: 'Acme',
      title: 'Software Engineer Intern',
      url: 'https://boards.greenhouse.io/acme/jobs/1',
      deadline: new Date('2026-08-20T00:00:00.000Z'),
    };
    const db = createFakeDb([
      [{ task, job }],
      [{ content: '## About the role' }],
      [{ storagePath: 'docs/resume-v3.pdf', filename: 'resume-v3.pdf' }],
      [
        {
          id: FOLLOWUP_ID,
          taskId: TASK_ID,
          kind: 'recruiter',
          title: 'Recruiter reply',
          state: 'WAITING',
          dueDate: null,
        },
      ],
      [
        {
          type: 'FORM_DISCOVERED',
          createdAt: new Date('2026-08-01T12:00:00.000Z'),
          data: { questionCount: 6, company: 'Acme' },
        },
        {
          type: 'RESOLVED_PARTIAL',
          createdAt: new Date('2026-07-02T12:00:00.000Z'),
          data: { resolved: 4, missing: 1, requiredMissing: 0 },
        },
        {
          type: 'PARSE_OK',
          createdAt: new Date('2026-07-01T12:00:00.000Z'),
          data: null,
        },
      ],
    ]);
    const app = buildServer(createDeps(db));
    const response = await app.inject({
      method: 'GET',
      url: `/mobile/tasks/${TASK_ID}`,
      headers: AUTH,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();

    expect(body.task).toEqual({
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
    });
    expect(body.description).toBe('## About the role');

    // resolved values rendered as display text: plain string, option label,
    // document filename, array joined; missing/unresolved carry value null.
    expect(body.questions).toEqual([
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
        id: 'q-resume',
        label: 'Resume',
        type: 'file',
        required: true,
        status: 'resolved',
        value: 'resume-v3.pdf',
        source: 'document',
      },
      {
        id: 'q-langs',
        label: 'Languages',
        type: 'multiselect',
        required: false,
        status: 'resolved',
        value: 'TypeScript, Go',
        source: 'user',
      },
      {
        id: 'q-cover',
        label: 'Cover letter',
        type: 'textarea',
        required: false,
        limit: { kind: 'characters', max: 500 },
        status: 'missing',
        value: null,
        source: null,
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
    ]);

    expect(body.followups).toEqual([
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
      },
    ]);

    expect(body.timeline).toEqual([
      {
        type: 'FORM_DISCOVERED',
        at: '2026-08-01T12:00:00.000Z',
        summary: 'Form discovered — 6 questions',
      },
      {
        type: 'RESOLVED_PARTIAL',
        at: '2026-07-02T12:00:00.000Z',
        summary: 'Resolved partial — 4 resolved, 1 missing',
      },
      {
        type: 'PARSE_OK',
        at: '2026-07-01T12:00:00.000Z',
        summary: 'Parse ok',
      },
    ]);
    await app.close();
  });

  it('marks every question unresolved when no resolution exists', async () => {
    const task = {
      id: TASK_ID,
      state: 'NEEDS_INPUT',
      priority: 0,
      notes: null,
      dueDate: null,
      jobSpec: {
        platform: 'unknown',
        tenant: '',
        externalId: '',
        title: '',
        applyUrl: 'https://example.com/apply',
        questions: [
          { id: 'q1', label: 'Full name', type: 'text', required: true },
        ],
      },
      resolution: null,
      createdAt: null,
      updatedAt: null,
    };
    const job = {
      company: null,
      title: null,
      url: 'https://example.com/apply',
      deadline: null,
    };
    const db = createFakeDb([[{ task, job }], [], [], [], []]);
    const app = buildServer(createDeps(db));
    const response = await app.inject({
      method: 'GET',
      url: `/mobile/tasks/${TASK_ID}`,
      headers: AUTH,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.description).toBeNull();
    expect(body.questions).toEqual([
      {
        id: 'q1',
        label: 'Full name',
        type: 'text',
        required: true,
        status: 'unresolved',
        value: null,
        source: null,
      },
    ]);
    // No identity anywhere → URL-host fallback.
    expect(body.task).toMatchObject({
      company: 'example.com',
      title: null,
      dueDate: null,
    });
    await app.close();
  });
});

describe('GET /mobile/followups/:id', () => {
  it('404s on an unknown follow-up', async () => {
    const app = buildServer(createDeps(createFakeDb([[]])));
    const response = await app.inject({
      method: 'GET',
      url: `/mobile/followups/${FOLLOWUP_ID}`,
      headers: AUTH,
    });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it('returns the follow-up with labels and the parent task identity', async () => {
    const db = createFakeDb([
      [
        {
          followup: {
            id: FOLLOWUP_ID,
            taskId: SENT_TASK_ID,
            kind: 'offer',
            title: 'Offer call',
            state: 'SCHEDULED',
            url: 'https://cal.example.com/offer',
            notes: 'ask about start dates',
            sourceBody: 'From: recruiter@acme.com\n\nCongrats!',
            dueDate: new Date('2026-08-12T04:00:00.000Z'),
          },
          taskId: SENT_TASK_ID,
          jobSpec: { company: 'SpecCo', title: 'Spec Role' },
          company: null,
          title: null,
          url: 'https://boards.greenhouse.io/acme/jobs/1',
        },
      ],
    ]);
    const app = buildServer(createDeps(db));
    const response = await app.inject({
      method: 'GET',
      url: `/mobile/followups/${FOLLOWUP_ID}`,
      headers: AUTH,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      followup: {
        id: FOLLOWUP_ID,
        taskId: SENT_TASK_ID,
        kind: 'offer',
        kindLabel: 'Offer',
        title: 'Offer call',
        state: 'SCHEDULED',
        stateLabel: 'Scheduled',
        dueDate: '2026-08-12T04:00:00.000Z',
        url: 'https://cal.example.com/offer',
        notes: 'ask about start dates',
        sourceBody: 'From: recruiter@acme.com\n\nCongrats!',
      },
      task: {
        id: SENT_TASK_ID,
        company: 'SpecCo',
        title: 'Spec Role',
      },
    });
    await app.close();
  });
});
