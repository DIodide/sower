import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from './config.js';
import { MAX_ATTEMPTS, processTask } from './process.js';
import type { Deps, Notifier } from './types.js';

const adapterState = vi.hoisted(() => ({
  discoverError: null as string | null,
  questions: [] as unknown[],
  lastDiscoverOpts: undefined as { recorder?: unknown } | undefined,
}));

const answersState = vi.hoisted(() => ({
  result: { resolved: [], missing: [] } as {
    resolved: unknown[];
    missing: unknown[];
  },
  lastOpts: undefined as unknown,
}));

vi.mock('@sower/platforms', () => ({
  getAdapter: (platform: string) =>
    platform === 'greenhouse'
      ? {
          discover: async (
            _ref: unknown,
            _url: unknown,
            opts?: { recorder?: unknown },
          ) => {
            adapterState.lastDiscoverOpts = opts;
            if (adapterState.discoverError) {
              throw new Error(adapterState.discoverError);
            }
            return {
              platform: 'greenhouse',
              tenant: 'acme',
              externalId: 'swe-1',
              title: 'Software Engineer Intern',
              applyUrl: 'https://boards.greenhouse.io/acme/jobs/123',
              questions: adapterState.questions,
            };
          },
          submit: async () => {
            throw new Error('submit disabled');
          },
        }
      : null,
}));

vi.mock('@sower/answers', () => ({
  loadProfile: async () => ({}),
  resolveAnswers: (_questions: unknown, _profile: unknown, opts?: unknown) => {
    answersState.lastOpts = opts;
    return answersState.result;
  },
}));

interface FakeTaskRow {
  id: string;
  jobId: string;
  state: string;
  attempt: number;
  jobSpec: unknown;
  resolution: unknown;
  lastError: string | null;
  updatedAt: Date;
  approvalChannelId?: string;
  approvalMessageId?: string;
}

interface FakeEventRow {
  taskId: string;
  type: string;
  fromState: string | null;
  toState: string | null;
  data: unknown;
}

/**
 * Stateful fake db holding a single task row. Mimics the drizzle surface
 * processTask uses. The claim (`update ... returning()`) is applied atomically
 * at await-time so concurrent claims race exactly like they would against
 * Postgres: only one caller gets the row back.
 */
function createFakeTaskDb(initial: { state: string; attempt?: number }) {
  const task: FakeTaskRow = {
    id: 'task-1',
    jobId: 'job-1',
    state: initial.state,
    attempt: initial.attempt ?? 0,
    jobSpec: null,
    resolution: null,
    lastError: null,
    updatedAt: new Date(0),
  };
  const job = {
    id: 'job-1',
    url: 'https://boards.greenhouse.io/acme/jobs/123',
    platform: 'greenhouse',
    tenant: 'acme',
    externalId: 'swe-1',
  };
  const eventRows: FakeEventRow[] = [];

  const db = {
    select: (fields?: Record<string, unknown>) => {
      // Bank (answers) and documents selects resolve empty; the task+job
      // lookup resolves the single task row.
      const isBankSelect = fields !== undefined && 'normalizedLabel' in fields;
      const isDocumentsSelect = fields !== undefined && 'kind' in fields;
      const result =
        isBankSelect || isDocumentsSelect ? [] : [{ task: { ...task }, job }];
      const chain = {
        from: () => chain,
        innerJoin: () => chain,
        where: () => chain,
        limit: () => chain,
        // biome-ignore lint/suspicious/noThenProperty: mimics drizzle's awaitable builder
        then: (onFulfilled: (value: unknown) => unknown) =>
          Promise.resolve(result).then(onFulfilled),
      };
      return chain;
    },
    update: () => ({
      set: (setArg: Record<string, unknown>) => ({
        where: () => {
          const applyPlain = () => {
            for (const [key, value] of Object.entries(setArg)) {
              if (key === 'attempt') continue; // claim-only sql expression
              (task as unknown as Record<string, unknown>)[key] = value;
            }
            return [];
          };
          const applyClaim = () => {
            const claimable =
              (task.state === 'QUEUED' || task.state === 'FAILED') &&
              task.attempt < MAX_ATTEMPTS;
            if (!claimable) {
              return [];
            }
            task.state = 'PREPARING';
            task.attempt += 1;
            return [{ ...task }];
          };
          return {
            returning: () => ({
              // biome-ignore lint/suspicious/noThenProperty: mimics drizzle's awaitable builder
              then: (onFulfilled: (value: unknown) => unknown) =>
                Promise.resolve().then(applyClaim).then(onFulfilled),
            }),
            // biome-ignore lint/suspicious/noThenProperty: mimics drizzle's awaitable builder
            then: (onFulfilled: (value: unknown) => unknown) =>
              Promise.resolve().then(applyPlain).then(onFulfilled),
          };
        },
      }),
    }),
    insert: () => ({
      values: (row: FakeEventRow) => ({
        // biome-ignore lint/suspicious/noThenProperty: mimics drizzle's awaitable builder
        then: (onFulfilled: (value: unknown) => unknown) =>
          Promise.resolve()
            .then(() => {
              eventRows.push(row);
              return [];
            })
            .then(onFulfilled),
      }),
    }),
  };

  return { db: db as unknown as Deps['db'], task, eventRows };
}

/** Fake db whose only select resolves to no rows (task deleted). */
function createEmptyDb(): Deps['db'] {
  const chain = {
    from: () => chain,
    innerJoin: () => chain,
    where: () => chain,
    limit: () => chain,
    // biome-ignore lint/suspicious/noThenProperty: mimics drizzle's awaitable builder
    then: (onFulfilled: (value: unknown) => unknown) =>
      Promise.resolve([]).then(onFulfilled),
  };
  return { select: () => chain } as unknown as Deps['db'];
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
  DISCORD_BOT_TOKEN: undefined,
  DISCORD_PUBLIC_KEY: 'test-public-key',
  DISCORD_APP_ID: 'test-app-id',
  DISCORD_CHANNEL_MAP: undefined,
  DISCORD_ENABLED: false,
};

function createDeps(db: Deps['db'], overrides: Partial<Deps> = {}): Deps {
  return {
    db,
    queue: { enqueueProcess: vi.fn(async () => {}) },
    config,
    logger: false,
    ...overrides,
  };
}

/** Fake Discord notifier; the token is never read here (env-only in prod). */
function createNotify() {
  return {
    postApprovalCard: vi.fn(async () => ({
      channelId: 'chan-1',
      messageId: 'msg-1',
    })),
    updateApprovalCard: vi.fn(async () => {}),
    verifyInteraction: vi.fn(() => true),
    applyVerdict: vi.fn(() => ({ embeds: [], components: [] })),
  } satisfies Notifier;
}

/** Config permutation with Discord enabled (fake token, obviously not real). */
const discordConfig: Config = {
  ...config,
  DISCORD_BOT_TOKEN: 'test-not-a-real-token',
  DISCORD_ENABLED: true,
};

beforeEach(() => {
  adapterState.discoverError = null;
  adapterState.questions = [];
  adapterState.lastDiscoverOpts = undefined;
  answersState.result = { resolved: [], missing: [] };
  answersState.lastOpts = undefined;
});

describe('processTask', () => {
  it('returns not_found for a deleted task', async () => {
    const outcome = await processTask(createDeps(createEmptyDb()), 'task-1');
    expect(outcome).toEqual({ kind: 'not_found' });
  });

  it('claims a QUEUED task and moves it to REVIEW when nothing is missing', async () => {
    const { db, task, eventRows } = createFakeTaskDb({ state: 'QUEUED' });
    answersState.result = {
      resolved: [{ questionId: 'email', source: 'profile', value: 'x' }],
      missing: [],
    };

    const outcome = await processTask(createDeps(db), 'task-1');

    expect(outcome).toEqual({
      kind: 'processed',
      state: 'REVIEW',
      resolved: 1,
      missing: 0,
    });
    expect(task.state).toBe('REVIEW');
    expect(task.attempt).toBe(1);
    expect(task.resolution).toEqual({
      resolved: answersState.result.resolved,
      missing: [],
      requiredMissingCount: 0,
      optionalMissingCount: 0,
    });
    expect(eventRows.map((e) => [e.type, e.fromState, e.toState])).toEqual([
      ['PROCESS_START', 'QUEUED', 'PREPARING'],
      ['RESOLVED_ALL', 'PREPARING', 'REVIEW'],
    ]);
    // A per-task recorder is handed to the adapter, and the answers bank +
    // documents (empty here) are passed through to resolveAnswers.
    expect(adapterState.lastDiscoverOpts?.recorder).toBeTypeOf('function');
    expect(answersState.lastOpts).toEqual({ bank: [], documents: [] });
  });

  it('moves to REVIEW when only OPTIONAL answers are missing', async () => {
    const { db, task, eventRows } = createFakeTaskDb({ state: 'QUEUED' });
    const optionalQuestion = {
      id: 'nickname',
      label: 'Nickname',
      type: 'text',
      required: false,
    };
    answersState.result = { resolved: [], missing: [optionalQuestion] };

    const outcome = await processTask(createDeps(db), 'task-1');

    expect(outcome).toEqual({
      kind: 'processed',
      state: 'REVIEW',
      resolved: 0,
      missing: 1,
    });
    expect(task.state).toBe('REVIEW');
    expect(task.resolution).toEqual({
      resolved: [],
      missing: [optionalQuestion],
      requiredMissingCount: 0,
      optionalMissingCount: 1,
    });
    expect(eventRows.at(-1)?.type).toBe('RESOLVED_ALL');
  });

  it('moves to NEEDS_INPUT when a REQUIRED answer is missing', async () => {
    const { db, task, eventRows } = createFakeTaskDb({ state: 'QUEUED' });
    const requiredQuestion = {
      id: 'resume',
      label: 'Resume',
      type: 'file',
      required: true,
    };
    const optionalQuestion = {
      id: 'nickname',
      label: 'Nickname',
      type: 'text',
      required: false,
    };
    answersState.result = {
      resolved: [],
      missing: [requiredQuestion, optionalQuestion],
    };

    const outcome = await processTask(createDeps(db), 'task-1');

    expect(outcome).toEqual({
      kind: 'processed',
      state: 'NEEDS_INPUT',
      resolved: 0,
      missing: 2,
    });
    expect(task.state).toBe('NEEDS_INPUT');
    expect(task.resolution).toEqual({
      resolved: [],
      missing: [requiredQuestion, optionalQuestion],
      requiredMissingCount: 1,
      optionalMissingCount: 1,
    });
    expect(eventRows.at(-1)?.type).toBe('RESOLVED_PARTIAL');
  });

  it('skips a task that is not in a claimable state', async () => {
    const { db, task, eventRows } = createFakeTaskDb({ state: 'REVIEW' });
    const outcome = await processTask(createDeps(db), 'task-1');
    expect(outcome).toEqual({ kind: 'skipped', state: 'REVIEW' });
    expect(task.state).toBe('REVIEW');
    expect(task.attempt).toBe(0);
    expect(eventRows).toHaveLength(0);
  });

  it('double-claim: exactly one of two concurrent calls wins, the other skips', async () => {
    const { db, task, eventRows } = createFakeTaskDb({ state: 'QUEUED' });
    const deps = createDeps(db);

    const [a, b] = await Promise.all([
      processTask(deps, 'task-1'),
      processTask(deps, 'task-1'),
    ]);

    const kinds = [a.kind, b.kind].sort();
    expect(kinds).toEqual(['processed', 'skipped']);
    expect(task.attempt).toBe(1);
    const starts = eventRows.filter((e) => e.type === 'PROCESS_START');
    expect(starts).toHaveLength(1);
    expect(task.state).toBe('REVIEW');
  });

  it('re-claims a FAILED task (Cloud Tasks re-delivery) with the true fromState', async () => {
    const { db, task, eventRows } = createFakeTaskDb({
      state: 'FAILED',
      attempt: 2,
    });

    const outcome = await processTask(createDeps(db), 'task-1');

    expect(outcome).toEqual({
      kind: 'processed',
      state: 'REVIEW',
      resolved: 0,
      missing: 0,
    });
    expect(task.attempt).toBe(3);
    expect(eventRows[0]).toMatchObject({
      type: 'PROCESS_START',
      fromState: 'FAILED',
      toState: 'PREPARING',
    });
  });

  it('attempt cap: refuses to claim a FAILED task with attempt >= MAX_ATTEMPTS', async () => {
    const { db, task, eventRows } = createFakeTaskDb({
      state: 'FAILED',
      attempt: MAX_ATTEMPTS,
    });

    const outcome = await processTask(createDeps(db), 'task-1');

    expect(outcome).toEqual({ kind: 'skipped', state: 'FAILED' });
    expect(task.state).toBe('FAILED');
    expect(task.attempt).toBe(MAX_ATTEMPTS);
    expect(eventRows).toHaveLength(0);
  });

  it('attempt cap: claims are exhausted after MAX_ATTEMPTS failing runs', async () => {
    const { db, task, eventRows } = createFakeTaskDb({ state: 'QUEUED' });
    adapterState.discoverError = 'greenhouse api unreachable';
    const deps = createDeps(db);

    for (let i = 1; i <= MAX_ATTEMPTS; i += 1) {
      const outcome = await processTask(deps, 'task-1');
      expect(outcome).toEqual({
        kind: 'failed',
        error: 'greenhouse api unreachable',
        attempt: i,
        gaveUp: i >= MAX_ATTEMPTS,
      });
    }
    expect(task.state).toBe('FAILED');
    expect(task.attempt).toBe(MAX_ATTEMPTS);

    const exhausted = await processTask(deps, 'task-1');
    expect(exhausted).toEqual({ kind: 'skipped', state: 'FAILED' });
    expect(task.attempt).toBe(MAX_ATTEMPTS);
    expect(eventRows.filter((e) => e.type === 'PROCESS_START')).toHaveLength(
      MAX_ATTEMPTS,
    );
  });

  it('records FAIL from the actual state and stores lastError on failure', async () => {
    const { db, task, eventRows } = createFakeTaskDb({ state: 'QUEUED' });
    adapterState.discoverError = 'boom';

    const outcome = await processTask(createDeps(db), 'task-1');

    expect(outcome).toEqual({
      kind: 'failed',
      error: 'boom',
      attempt: 1,
      gaveUp: false,
    });
    expect(task.state).toBe('FAILED');
    expect(task.lastError).toBe('boom');
    expect(eventRows.at(-1)).toMatchObject({
      type: 'FAIL',
      fromState: 'PREPARING',
      toState: 'FAILED',
      data: { error: 'boom', attempt: 1 },
    });
  });
});

describe('processTask Discord approval card (REVIEW hook)', () => {
  it('posts a card and stores {channelId,messageId} when the task lands in REVIEW', async () => {
    const { db, task } = createFakeTaskDb({ state: 'QUEUED' });
    answersState.result = {
      resolved: [
        { questionId: 'email', source: 'profile', value: 'x' },
        {
          questionId: 'resume',
          source: 'document',
          value: 'documents/doc-1/resume.pdf',
        },
      ],
      missing: [],
    };
    const notify = createNotify();
    const deps = createDeps(db, { notify, config: discordConfig });

    const outcome = await processTask(deps, 'task-1');

    expect(outcome.kind).toBe('processed');
    expect(task.state).toBe('REVIEW');
    expect(notify.postApprovalCard).toHaveBeenCalledTimes(1);
    expect(notify.postApprovalCard).toHaveBeenCalledWith({
      taskId: 'task-1',
      platform: 'greenhouse',
      company: '(unknown company)', // fake job/spec carry no company
      title: 'Software Engineer Intern',
      applyUrl: 'https://boards.greenhouse.io/acme/jobs/123',
      fieldCount: 2,
      fileCount: 1,
      missingRequired: 0,
    });
    // The card's location is stored for later edits (migration 0002 columns).
    expect(task.approvalChannelId).toBe('chan-1');
    expect(task.approvalMessageId).toBe('msg-1');
  });

  it('skips the card silently when Discord is disabled (no DISCORD_BOT_TOKEN)', async () => {
    const { db, task } = createFakeTaskDb({ state: 'QUEUED' });
    const notify = createNotify();
    // config (not discordConfig): DISCORD_ENABLED false.
    const deps = createDeps(db, { notify });

    const outcome = await processTask(deps, 'task-1');

    expect(outcome.kind).toBe('processed');
    expect(task.state).toBe('REVIEW');
    expect(notify.postApprovalCard).not.toHaveBeenCalled();
    expect(task.approvalChannelId).toBeUndefined();
  });

  it('does not post a card when the task lands in NEEDS_INPUT', async () => {
    const { db, task } = createFakeTaskDb({ state: 'QUEUED' });
    answersState.result = {
      resolved: [],
      missing: [
        { id: 'resume', label: 'Resume', type: 'file', required: true },
      ],
    };
    const notify = createNotify();
    const deps = createDeps(db, { notify, config: discordConfig });

    const outcome = await processTask(deps, 'task-1');

    expect(outcome.kind).toBe('processed');
    expect(task.state).toBe('NEEDS_INPUT');
    expect(notify.postApprovalCard).not.toHaveBeenCalled();
  });

  it('never fails processing when posting the card throws (best-effort)', async () => {
    const { db, task } = createFakeTaskDb({ state: 'QUEUED' });
    const notify = createNotify();
    notify.postApprovalCard.mockRejectedValueOnce(
      new Error('discord unreachable'),
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const deps = createDeps(db, { notify, config: discordConfig });

    const outcome = await processTask(deps, 'task-1');

    expect(outcome).toMatchObject({ kind: 'processed', state: 'REVIEW' });
    expect(task.state).toBe('REVIEW');
    expect(task.lastError).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
