import { fileURLToPath } from 'node:url';
import { apiCalls, applicationTasks, documents, events, jobs } from '@sower/db';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Config } from './config.js';
import { buildServer } from './server.js';
import type { Deps, Notifier } from './types.js';

/**
 * These tests exercise the requeue/approve/detail routes end-to-end through
 * buildServer with the REAL @sower/core state machine and the REAL
 * @sower/platforms GreenhouseAdapter (no vi.mock), so the approve test's
 * "fetch is never called" assertion covers the genuine dry-run code path.
 */

const TASK_ID = '7d8e9f10-1112-4314-a516-b71819c2d2e2';

interface FakeRow {
  [key: string]: unknown;
}

interface FakeState {
  /** null = task does not exist. */
  task: (FakeRow & { id: string; state: string; attempt: number }) | null;
  job: FakeRow;
  events: FakeRow[];
  apiCalls: FakeRow[];
  documents: FakeRow[];
}

function thenable(compute: () => unknown) {
  return {
    // biome-ignore lint/suspicious/noThenProperty: mimics drizzle's awaitable builder
    then: (
      onFulfilled: (value: unknown) => unknown,
      onRejected?: (reason: unknown) => unknown,
    ) => Promise.resolve().then(compute).then(onFulfilled, onRejected),
  };
}

/**
 * Stateful fake db dispatching on the actual drizzle table objects. Claim
 * updates (`update().set().where().returning()`) apply the same state gates
 * a real WHERE clause would: QUEUED claims only NEEDS_INPUT/FAILED tasks,
 * FILLING claims only REVIEW tasks.
 */
function createFakeDb(state: FakeState): Deps['db'] {
  function resultFor(table: unknown, fields?: Record<string, unknown>) {
    if (table === applicationTasks) {
      if (!state.task) {
        return [];
      }
      if (fields && 'task' in fields) {
        return [{ task: { ...state.task }, job: { ...state.job } }];
      }
      if (fields && 'state' in fields) {
        return [{ state: state.task.state }];
      }
      return [{ ...state.task }];
    }
    if (table === events) {
      return state.events.map((row) => ({ ...row }));
    }
    if (table === apiCalls) {
      if (fields && 'max' in fields) {
        const seqs = state.apiCalls.map((row) => row.seq as number);
        return [{ max: seqs.length === 0 ? null : Math.max(...seqs) }];
      }
      return state.apiCalls.map((row) => ({ ...row }));
    }
    if (table === documents) {
      return state.documents.map((row) => ({ ...row }));
    }
    if (table === jobs) {
      return [{ ...state.job }];
    }
    return [];
  }

  const db = {
    select: (fields?: Record<string, unknown>) => ({
      from: (table: unknown) => {
        const chain = {
          innerJoin: () => chain,
          where: () => chain,
          limit: () => chain,
          orderBy: () => chain,
          // biome-ignore lint/suspicious/noThenProperty: mimics drizzle's awaitable builder
          then: (
            onFulfilled: (value: unknown) => unknown,
            onRejected?: (reason: unknown) => unknown,
          ) =>
            Promise.resolve()
              .then(() => resultFor(table, fields))
              .then(onFulfilled, onRejected),
        };
        return chain;
      },
    }),
    update: (_table: unknown) => ({
      set: (setArg: Record<string, unknown>) => ({
        where: () => ({
          returning: () =>
            thenable(() => {
              const task = state.task;
              if (!task) {
                return [];
              }
              const claimable =
                setArg.state === 'QUEUED'
                  ? task.state === 'NEEDS_INPUT' || task.state === 'FAILED'
                  : setArg.state === 'FILLING'
                    ? task.state === 'REVIEW'
                    : false;
              if (!claimable) {
                return [];
              }
              Object.assign(task, setArg);
              return [{ ...task }];
            }),
          // biome-ignore lint/suspicious/noThenProperty: mimics drizzle's awaitable builder
          then: (
            onFulfilled: (value: unknown) => unknown,
            onRejected?: (reason: unknown) => unknown,
          ) =>
            Promise.resolve()
              .then(() => {
                if (state.task) {
                  Object.assign(state.task, setArg);
                }
                return [];
              })
              .then(onFulfilled, onRejected),
        }),
      }),
    }),
    insert: (table: unknown) => ({
      values: (row: FakeRow) =>
        thenable(() => {
          if (table === events) {
            state.events.push(row);
          } else if (table === apiCalls) {
            state.apiCalls.push(row);
          } else {
            throw new Error('unexpected insert in fake db');
          }
          return [];
        }),
    }),
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
};

const jobSpec = {
  platform: 'greenhouse',
  tenant: 'acme',
  externalId: 'swe-1',
  title: 'Software Engineer Intern',
  company: 'Acme',
  applyUrl: 'https://boards.greenhouse.io/acme/jobs/123',
  questions: [
    { id: 'email', label: 'Email', type: 'text', required: true },
    { id: 'resume', label: 'Resume', type: 'file', required: true },
  ],
};

const resolution = {
  resolved: [
    { questionId: 'email', source: 'profile', value: 'ada@example.com' },
    {
      questionId: 'resume',
      source: 'document',
      value: 'documents/doc-1/resume.pdf',
    },
  ],
  missing: [],
  requiredMissingCount: 0,
  optionalMissingCount: 0,
};

function createState(
  taskOverrides: Partial<FakeRow> & { state?: string } = {},
): FakeState {
  return {
    task: {
      id: TASK_ID,
      jobId: 'job-1',
      state: 'REVIEW',
      attempt: 2,
      jobSpec,
      resolution,
      lastError: null,
      createdAt: '2026-07-11T00:00:00.000Z',
      updatedAt: '2026-07-11T00:00:00.000Z',
      ...taskOverrides,
    },
    job: {
      id: 'job-1',
      url: 'https://boards.greenhouse.io/acme/jobs/123',
      canonicalUrl: 'https://boards.greenhouse.io/acme/jobs/123',
      company: 'Acme',
      title: 'Software Engineer Intern',
      platform: 'greenhouse',
      tenant: 'acme',
      externalId: 'swe-1',
      terms: ['Summer 2027'],
      source: 'simplify',
      createdAt: '2026-07-11T00:00:00.000Z',
    },
    events: [],
    apiCalls: [],
    documents: [
      {
        id: 'doc-1',
        kind: 'resume',
        filename: 'resume.pdf',
        storagePath: 'documents/doc-1/resume.pdf',
        contentType: 'application/pdf',
        sizeBytes: 123,
        createdAt: '2026-07-11T00:00:00.000Z',
      },
    ],
  };
}

function createDeps(state: FakeState, overrides: Partial<Deps> = {}) {
  const enqueueProcess = vi.fn(async (_taskId: string) => {});
  const deps: Deps = {
    db: createFakeDb(state),
    queue: { enqueueProcess },
    config,
    logger: false,
    ...overrides,
  };
  return { deps, enqueueProcess };
}

/** Fake Discord notifier (no fetch anywhere; token never read in tests). */
function createNotify(): Notifier {
  return {
    postApprovalCard: vi.fn(async () => ({
      channelId: 'chan-1',
      messageId: 'msg-1',
    })),
    postOtpRequestCard: vi.fn(async () => ({
      channelId: 'chan-1',
      messageId: 'otp-msg-1',
    })),
    updateApprovalCard: vi.fn(async () => {}),
    verifyInteraction: vi.fn(() => true),
    applyVerdict: vi.fn(() => ({ embeds: [], components: [] })),
    fetchChannelMessages: vi.fn(async () => []),
    addReaction: vi.fn(async () => {}),
    postChannelMessage: vi.fn(async () => {}),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('POST /tasks/:id/requeue', () => {
  it('responds 401 without an api key', async () => {
    const { deps } = createDeps(createState());
    const app = buildServer(deps);
    const res = await app.inject({
      method: 'POST',
      url: `/tasks/${TASK_ID}/requeue`,
    });
    expect(res.statusCode).toBe(401);
  });

  it('requeues a NEEDS_INPUT task: resets attempt, records RETRY, enqueues', async () => {
    const state = createState({ state: 'NEEDS_INPUT', attempt: 4 });
    const { deps, enqueueProcess } = createDeps(state);
    const app = buildServer(deps);

    const res = await app.inject({
      method: 'POST',
      url: `/tasks/${TASK_ID}/requeue`,
      headers: { 'x-api-key': 'test-key' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ state: 'QUEUED' });
    expect(state.task?.state).toBe('QUEUED');
    expect(state.task?.attempt).toBe(0);
    expect(state.events).toHaveLength(1);
    expect(state.events[0]).toMatchObject({
      taskId: TASK_ID,
      type: 'RETRY',
      fromState: 'NEEDS_INPUT',
      toState: 'QUEUED',
    });
    expect(enqueueProcess).toHaveBeenCalledTimes(1);
    expect(enqueueProcess).toHaveBeenCalledWith(TASK_ID);
  });

  it('requeues a FAILED task', async () => {
    const state = createState({ state: 'FAILED', attempt: 5 });
    const { deps, enqueueProcess } = createDeps(state);
    const app = buildServer(deps);

    const res = await app.inject({
      method: 'POST',
      url: `/tasks/${TASK_ID}/requeue`,
      headers: { 'x-api-key': 'test-key' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ state: 'QUEUED' });
    expect(state.task?.attempt).toBe(0);
    expect(state.events[0]).toMatchObject({
      type: 'RETRY',
      fromState: 'FAILED',
      toState: 'QUEUED',
    });
    expect(enqueueProcess).toHaveBeenCalledWith(TASK_ID);
  });

  it('skips a task in a non-requeueable state (no event, no enqueue)', async () => {
    const state = createState({ state: 'REVIEW', attempt: 2 });
    const { deps, enqueueProcess } = createDeps(state);
    const app = buildServer(deps);

    const res = await app.inject({
      method: 'POST',
      url: `/tasks/${TASK_ID}/requeue`,
      headers: { 'x-api-key': 'test-key' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ skipped: true, state: 'REVIEW' });
    expect(state.task?.state).toBe('REVIEW');
    expect(state.task?.attempt).toBe(2);
    expect(state.events).toHaveLength(0);
    expect(enqueueProcess).not.toHaveBeenCalled();
  });

  it('responds 404 for an unknown task', async () => {
    const state = createState();
    state.task = null;
    const { deps } = createDeps(state);
    const app = buildServer(deps);

    const res = await app.inject({
      method: 'POST',
      url: `/tasks/${TASK_ID}/requeue`,
      headers: { 'x-api-key': 'test-key' },
    });

    expect(res.statusCode).toBe(404);
  });

  it('responds 400 for a non-uuid task id', async () => {
    const { deps } = createDeps(createState());
    const app = buildServer(deps);
    const res = await app.inject({
      method: 'POST',
      url: '/tasks/not-a-uuid/requeue',
      headers: { 'x-api-key': 'test-key' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('POST /tasks/:id/approve', () => {
  it('dry-run submits a REVIEW task with ZERO network I/O and records submit_dryrun', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('SAFETY VIOLATION: fetch called during approve dry-run');
    });
    const state = createState({ state: 'REVIEW' });
    const { deps } = createDeps(state);
    const app = buildServer(deps);

    const res = await app.inject({
      method: 'POST',
      url: `/tasks/${TASK_ID}/approve`,
      headers: { 'x-api-key': 'test-key' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      state: 'REVIEW',
      mode: 'dry-run',
      dryRun: true,
      note: 'Dry-run submit recorded (2 field(s), 1 file(s)); no real application was sent.',
      payloadSummary: { fieldCount: 2, fileCount: 1 },
    });

    // SAFETY: the entire approve flow performed no HTTP request.
    expect(fetchSpy).not.toHaveBeenCalled();

    // Task went REVIEW -> FILLING -> REVIEW via the state machine.
    expect(state.task?.state).toBe('REVIEW');
    expect(state.events.map((e) => [e.type, e.fromState, e.toState])).toEqual([
      ['APPROVED', 'REVIEW', 'FILLING'],
      ['FILLED', 'FILLING', 'REVIEW'],
    ]);
    expect(state.events[1]?.data).toEqual({ dryRun: true });

    // Exactly one api_calls row: the recorded dry-run payload representation.
    expect(state.apiCalls).toHaveLength(1);
    const call = state.apiCalls[0] as Record<string, unknown>;
    expect(call).toMatchObject({
      taskId: TASK_ID,
      seq: 1,
      phase: 'submit_dryrun',
      method: 'POST',
      url: 'https://boards.greenhouse.io/acme/jobs/123',
      dryRun: true,
      durationMs: 0,
    });
    expect(call.requestBody).toEqual({
      email: 'ada@example.com',
      resume: {
        kind: 'file',
        filename: 'resume.pdf',
        storagePath: 'documents/doc-1/resume.pdf',
      },
    });
  });

  it('edits the stored Discord card to submitted-dryrun after a dashboard approve', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('SAFETY VIOLATION: fetch called during approve dry-run');
    });
    const state = createState({
      state: 'REVIEW',
      approvalChannelId: 'chan-1',
      approvalMessageId: 'msg-1',
    });
    const notify = createNotify();
    const { deps } = createDeps(state, {
      notify,
      config: {
        ...config,
        DISCORD_BOT_TOKEN: 'test-not-a-real-token',
        DISCORD_ENABLED: true,
      },
    });
    const app = buildServer(deps);

    const res = await app.inject({
      method: 'POST',
      url: `/tasks/${TASK_ID}/approve`,
      headers: { 'x-api-key': 'test-key' },
    });

    expect(res.statusCode).toBe(200);
    // The card ref never leaks to clients; the honest per-mode note does.
    expect(res.json()).toEqual({
      state: 'REVIEW',
      mode: 'dry-run',
      dryRun: true,
      note: 'Dry-run submit recorded (2 field(s), 1 file(s)); no real application was sent.',
      payloadSummary: { fieldCount: 2, fileCount: 1 },
    });
    expect(notify.updateApprovalCard).toHaveBeenCalledTimes(1);
    expect(notify.updateApprovalCard).toHaveBeenCalledWith(
      'chan-1',
      'msg-1',
      'submitted-dryrun',
      'Dry-run submit recorded (2 field(s), 1 file(s)); no real application was sent.',
    );
    // The notifier is the only Discord surface; no direct fetch happened.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('leaves Discord untouched on approve when the task has no stored card', async () => {
    const state = createState({ state: 'REVIEW' });
    const notify = createNotify();
    const { deps } = createDeps(state, {
      notify,
      config: {
        ...config,
        DISCORD_BOT_TOKEN: 'test-not-a-real-token',
        DISCORD_ENABLED: true,
      },
    });
    const app = buildServer(deps);

    const res = await app.inject({
      method: 'POST',
      url: `/tasks/${TASK_ID}/approve`,
      headers: { 'x-api-key': 'test-key' },
    });

    expect(res.statusCode).toBe(200);
    expect(notify.updateApprovalCard).not.toHaveBeenCalled();
  });

  it('skips a task that is not in REVIEW (no events, no api calls, no fetch)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('SAFETY VIOLATION: fetch called during approve');
    });
    const state = createState({ state: 'NEEDS_INPUT' });
    const { deps } = createDeps(state);
    const app = buildServer(deps);

    const res = await app.inject({
      method: 'POST',
      url: `/tasks/${TASK_ID}/approve`,
      headers: { 'x-api-key': 'test-key' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ skipped: true, state: 'NEEDS_INPUT' });
    expect(state.task?.state).toBe('NEEDS_INPUT');
    expect(state.events).toHaveLength(0);
    expect(state.apiCalls).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('fails the task (FILLING -> FAILED) when it has no job spec', async () => {
    const state = createState({ state: 'REVIEW', jobSpec: null });
    const { deps } = createDeps(state);
    const app = buildServer(deps);

    const res = await app.inject({
      method: 'POST',
      url: `/tasks/${TASK_ID}/approve`,
      headers: { 'x-api-key': 'test-key' },
    });

    expect(res.statusCode).toBe(500);
    expect(state.task?.state).toBe('FAILED');
    expect(state.task?.lastError).toMatch(/no job spec/);
    expect(state.events.map((e) => [e.type, e.fromState, e.toState])).toEqual([
      ['APPROVED', 'REVIEW', 'FILLING'],
      ['FAIL', 'FILLING', 'FAILED'],
    ]);
  });

  it('responds 404 for an unknown task', async () => {
    const state = createState();
    state.task = null;
    const { deps } = createDeps(state);
    const app = buildServer(deps);

    const res = await app.inject({
      method: 'POST',
      url: `/tasks/${TASK_ID}/approve`,
      headers: { 'x-api-key': 'test-key' },
    });

    expect(res.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Workday approve -> real calypso fill (fill-then-stop), the spine completion.
// Uses the REAL CalypsoClient + fillViaCalypso against a mocked fetch, so the
// "never finalize" and "fills exactly what was reviewed" guarantees are
// exercised end-to-end through the approve route.
// ---------------------------------------------------------------------------

describe('POST /tasks/:id/approve (workday calypso fill)', () => {
  const SAMPLE_PROFILE_PATH = fileURLToPath(
    new URL('../../../config/profile.sample.yaml', import.meta.url),
  );
  const WORKDAY_HOST = 'caci.wd1.myworkdayjobs.com';
  const SLUG = 'Software-Engineering-Intern---Fall-2026_328740';
  const SESSION = {
    host: WORKDAY_HOST,
    tenant: 'caci',
    cookie: 'PLAY_SESSION=redacted',
    csrfToken: 'csrf-1',
  };

  const workdayJobSpec = {
    platform: 'workday',
    tenant: 'caci',
    externalId: '328740',
    title: 'Software Engineering Intern - Fall 2026',
    company: 'CACI',
    applyUrl: `https://${WORKDAY_HOST}/external/job/Jessup-MD-US/${SLUG}`,
    questions: [
      { id: 'Q1', label: 'Favorite color?', type: 'text', required: true },
    ],
    formAccess: 'public',
    meta: {
      site: 'external',
      externalPath: `/job/Jessup-MD-US/${SLUG}`,
      questionnaireId: 'QID-1',
    },
  };
  const workdayResolution = {
    resolved: [{ questionId: 'Q1', source: 'profile', value: 'Blue' }],
    missing: [],
    requiredMissingCount: 0,
    optionalMissingCount: 0,
  };

  function workdayState(taskOverrides: Partial<FakeRow> = {}): FakeState {
    return {
      task: {
        id: TASK_ID,
        jobId: 'job-wd',
        state: 'REVIEW',
        attempt: 1,
        jobSpec: workdayJobSpec,
        resolution: workdayResolution,
        lastError: null,
        createdAt: '2026-07-11T00:00:00.000Z',
        updatedAt: '2026-07-11T00:00:00.000Z',
        ...taskOverrides,
      },
      job: {
        id: 'job-wd',
        url: workdayJobSpec.applyUrl,
        company: 'CACI',
        title: workdayJobSpec.title,
        platform: 'workday',
        tenant: 'caci',
        externalId: '328740',
      },
      events: [],
      apiCalls: [],
      documents: [],
    };
  }

  /**
   * A path-aware vault: the session.json read is present (or absent when
   * session === null); any other path (the résumé) returns resumeBytes.
   */
  function sessionVault(session: unknown | null, resumeBytes?: Uint8Array) {
    return {
      exists: vi.fn(async (path: string) =>
        path.includes('session.json') ? session !== null : true,
      ),
      get: vi.fn(async (path: string) =>
        path.includes('session.json')
          ? Buffer.from(session === null ? '' : JSON.stringify(session))
          : Buffer.from(resumeBytes ?? new Uint8Array()),
      ),
      put: vi.fn(async () => {}),
    } as unknown as NonNullable<Deps['storage']>;
  }

  /** Mock fetch returning canned calypso responses; records every call URL. */
  function mockCalypsoFetch() {
    const calls: { method: string; url: string }[] = [];
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation((async (
      input: unknown,
      init?: RequestInit,
    ) => {
      const url = String(input);
      calls.push({ method: init?.method ?? 'GET', url });
      if (url.includes('/questionnaire/QID-1')) {
        return new Response(
          JSON.stringify({
            questions: [
              {
                id: 'Q1',
                body: 'Favorite color?',
                required: true,
                type: [{ descriptor: 'Text - Single Line' }],
              },
            ],
          }),
          { status: 200 },
        );
      }
      if (url.endsWith('/jobapplications')) {
        return new Response(JSON.stringify({ id: 'JA-99' }), { status: 200 });
      }
      if (url.endsWith('/attachments')) {
        return new Response(
          JSON.stringify({
            file: 'oms-attachments/ref-9',
            fileName: 'resume.pdf',
            fileLength: 4,
            contentType: { id: 'Content_Type_ID=application/pdf' },
          }),
          { status: 200 },
        );
      }
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch);
    return { calls, spy };
  }

  const workdayConfig: Config = {
    ...config,
    PROFILE_PATH: SAMPLE_PROFILE_PATH,
  };

  it('fills the Workday draft over HTTP and STOPS before finalize', async () => {
    const state = workdayState();
    const { calls } = mockCalypsoFetch();
    const { deps } = createDeps(state, {
      config: workdayConfig,
      storage: sessionVault(SESSION),
    });
    const app = buildServer(deps);

    const res = await app.inject({
      method: 'POST',
      url: `/tasks/${TASK_ID}/approve`,
      headers: { 'x-api-key': 'test-key' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.mode).toBe('workday-fill');
    expect(body.dryRun).toBe(false);
    expect(body.state).toBe('REVIEW');
    expect(body.note).toMatch(/Workday draft filled/);
    expect(body.note).toMatch(/stopped before submit/i);

    // GUARDRAIL: the fill NEVER hit finalize.
    expect(calls.some((c) => c.url.includes('/finalize'))).toBe(false);
    // It started the application at the derived job slug...
    expect(
      calls.some((c) => c.url.includes(`/jobpostings/${SLUG}/jobapplications`)),
    ).toBe(true);
    // ...and posted the questionnaire responses (the reviewed answer).
    expect(calls.some((c) => c.url.includes('/questionnaireresponses'))).toBe(
      true,
    );

    // Same spine as every platform: REVIEW -> FILLING -> REVIEW.
    expect(state.task?.state).toBe('REVIEW');
    expect(state.events.map((e) => [e.type, e.fromState, e.toState])).toEqual([
      ['APPROVED', 'REVIEW', 'FILLING'],
      ['FILLED', 'FILLING', 'REVIEW'],
    ]);
    const filled = state.events[1] as { data?: Record<string, unknown> };
    expect(filled.data).toMatchObject({
      dryRun: false,
      workday: { jobApplicationId: 'JA-99', answered: 1 },
    });
  });

  it('attaches the stored résumé via the two-step calypso attachments flow', async () => {
    const state = workdayState();
    // The user's stored résumé (kind='resume') — not a questionnaire question.
    state.documents = [
      {
        id: 'doc-r',
        kind: 'resume',
        filename: 'resume.pdf',
        storagePath: 'documents/doc-r/resume.pdf',
        contentType: 'application/pdf',
        createdAt: '2026-07-11T00:00:00.000Z',
      },
    ];
    const { calls } = mockCalypsoFetch();
    const { deps } = createDeps(state, {
      config: workdayConfig,
      storage: sessionVault(SESSION, new Uint8Array([1, 2, 3, 4])),
    });
    const app = buildServer(deps);

    const res = await app.inject({
      method: 'POST',
      url: `/tasks/${TASK_ID}/approve`,
      headers: { 'x-api-key': 'test-key' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.mode).toBe('workday-fill');
    expect(body.note).toMatch(/incl\. résumé/);
    expect(body.payloadSummary.fileCount).toBe(1);

    // Both attachment steps ran (multipart upload + JSON attach)...
    expect(calls.some((c) => c.url.endsWith('/common/caci/attachments'))).toBe(
      true,
    );
    expect(calls.some((c) => c.url.endsWith('/resumeattachments'))).toBe(true);
    // ...still never finalize.
    expect(calls.some((c) => c.url.includes('/finalize'))).toBe(false);

    const filled = state.events[1] as { data?: Record<string, unknown> };
    expect(filled.data).toMatchObject({
      workday: { resumeAttached: true },
    });
  });

  it('fails cleanly (FILLING -> FAILED) when no session is captured', async () => {
    const state = workdayState();
    const { calls } = mockCalypsoFetch();
    const { deps } = createDeps(state, {
      config: workdayConfig,
      storage: sessionVault(null), // nothing in the vault for this tenant
    });
    const app = buildServer(deps);

    const res = await app.inject({
      method: 'POST',
      url: `/tasks/${TASK_ID}/approve`,
      headers: { 'x-api-key': 'test-key' },
    });

    expect(res.statusCode).toBe(500);
    expect(res.json().error).toMatch(/no captured Workday session/);
    expect(state.task?.state).toBe('FAILED');
    expect(state.events.map((e) => [e.type, e.fromState, e.toState])).toEqual([
      ['APPROVED', 'REVIEW', 'FILLING'],
      ['FAIL', 'FILLING', 'FAILED'],
    ]);
    // No calypso HTTP happened — it bailed before constructing the client.
    expect(calls.some((c) => c.url.includes(WORKDAY_HOST))).toBe(false);
  });

  it('fails cleanly when no vault storage is configured', async () => {
    const state = workdayState();
    const { deps } = createDeps(state, { config: workdayConfig }); // no storage
    const app = buildServer(deps);

    const res = await app.inject({
      method: 'POST',
      url: `/tasks/${TASK_ID}/approve`,
      headers: { 'x-api-key': 'test-key' },
    });

    expect(res.statusCode).toBe(500);
    expect(res.json().error).toMatch(/needs vault storage/);
    expect(state.task?.state).toBe('FAILED');
  });
});

describe('GET /tasks/:id', () => {
  it('returns task + job + resolution + events + apiCalls', async () => {
    const state = createState({ state: 'REVIEW' });
    state.events = [
      {
        id: 'evt-1',
        taskId: TASK_ID,
        type: 'PROCESS_START',
        fromState: 'QUEUED',
        toState: 'PREPARING',
        data: { attempt: 1 },
        createdAt: '2026-07-11T00:00:01.000Z',
      },
      {
        id: 'evt-2',
        taskId: TASK_ID,
        type: 'RESOLVED_ALL',
        fromState: 'PREPARING',
        toState: 'REVIEW',
        data: null,
        createdAt: '2026-07-11T00:00:02.000Z',
      },
    ];
    state.apiCalls = [
      {
        id: 'call-1',
        taskId: TASK_ID,
        seq: 1,
        phase: 'discover',
        method: 'GET',
        url: 'https://boards-api.greenhouse.io/v1/boards/acme/jobs/swe-1?questions=true',
        responseStatus: 200,
        durationMs: 42,
        dryRun: false,
        createdAt: '2026-07-11T00:00:01.500Z',
      },
    ];
    const { deps } = createDeps(state);
    const app = buildServer(deps);

    const res = await app.inject({
      method: 'GET',
      url: `/tasks/${TASK_ID}`,
      headers: { 'x-api-key': 'test-key' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Object.keys(body).sort()).toEqual([
      'apiCalls',
      'events',
      'job',
      'resolution',
      'task',
    ]);
    expect(body.task.id).toBe(TASK_ID);
    expect(body.task.state).toBe('REVIEW');
    expect(body.job.id).toBe('job-1');
    expect(body.job.platform).toBe('greenhouse');
    expect(body.resolution).toEqual(resolution);
    expect(body.events).toHaveLength(2);
    expect(body.events[0].type).toBe('PROCESS_START');
    expect(body.apiCalls).toHaveLength(1);
    expect(body.apiCalls[0]).toMatchObject({
      seq: 1,
      phase: 'discover',
      method: 'GET',
      responseStatus: 200,
      dryRun: false,
    });
  });

  it('responds 404 for an unknown task', async () => {
    const state = createState();
    state.task = null;
    const { deps } = createDeps(state);
    const app = buildServer(deps);

    const res = await app.inject({
      method: 'GET',
      url: `/tasks/${TASK_ID}`,
      headers: { 'x-api-key': 'test-key' },
    });

    expect(res.statusCode).toBe(404);
  });
});
