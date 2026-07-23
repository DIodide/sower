import { describe, expect, it, vi } from 'vitest';
import type { Config } from './config.js';
import {
  consumePendingOtp,
  normalizeOtp,
  requestOtp,
  submitOtp,
} from './otp-actions.js';
import type { Deps, Notifier } from './types.js';

const TASK_ID = '3f0c8dbb-6f5e-4b57-9b1c-2a54d2b3c111';

interface FakeTask {
  id: string;
  state: string;
  jobSpec: unknown;
  pendingOtp: string | null;
  otpRequestedAt: Date | null;
  otpSubmittedAt: Date | null;
  otpChannelId: string | null;
  otpMessageId: string | null;
  [key: string]: unknown;
}

interface FakeState {
  task: FakeTask | null;
  job: Record<string, unknown>;
  events: Array<Record<string, unknown>>;
}

function createState(taskState = 'FILLING'): FakeState {
  return {
    task: {
      id: TASK_ID,
      state: taskState,
      jobSpec: {
        platform: 'workday',
        tenant: 'cadence',
        company: 'Cadence',
        title: 'Software Intern',
      },
      pendingOtp: null,
      otpRequestedAt: null,
      otpSubmittedAt: null,
      otpChannelId: null,
      otpMessageId: null,
    },
    job: {
      id: 'job-1',
      platform: 'workday',
      tenant: 'cadence',
      company: 'Cadence',
      title: 'Software Intern',
    },
    events: [],
  };
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
 * Fake of the drizzle surface otp-actions touches. Claims emulate the SQL
 * where-guards: requestOtp claims FILLING, submitOtp claims AWAITING_OTP,
 * consumePendingOtp's clear matches only while the code is still set.
 */
function createFakeDb(state: FakeState): Deps['db'] {
  const db = {
    select: (fields?: Record<string, unknown>) => {
      const chain = {
        from: () => chain,
        innerJoin: () => chain,
        where: () => chain,
        limit: () => chain,
        // biome-ignore lint/suspicious/noThenProperty: mimics drizzle's awaitable builder
        then: (onFulfilled: (value: unknown) => unknown) =>
          Promise.resolve()
            .then(() => {
              if (!state.task) return [];
              if (fields && 'task' in fields) {
                return [{ task: { ...state.task }, job: { ...state.job } }];
              }
              if (fields && 'pendingOtp' in fields) {
                return [{ pendingOtp: state.task.pendingOtp }];
              }
              if (fields && 'state' in fields) {
                return [{ state: state.task.state }];
              }
              return [{ ...state.task }];
            })
            .then(onFulfilled),
      };
      return chain;
    },
    update: () => ({
      set: (setArg: Record<string, unknown>) => ({
        where: () => ({
          returning: () =>
            thenable(() => {
              const task = state.task;
              if (!task) return [];
              if (setArg.state === 'AWAITING_OTP') {
                if (task.state !== 'FILLING') return [];
              } else if (setArg.state === 'FILLING') {
                if (task.state !== 'AWAITING_OTP') return [];
              } else if ('pendingOtp' in setArg && setArg.pendingOtp === null) {
                // consumePendingOtp clear: matches only while a code is set.
                if (task.pendingOtp === null) return [];
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
                if (state.task) Object.assign(state.task, setArg);
                return [];
              })
              .then(onFulfilled, onRejected),
        }),
      }),
    }),
    insert: () => ({
      values: (row: Record<string, unknown>) =>
        thenable(() => {
          state.events.push(row);
          return [];
        }),
    }),
  };
  return db as unknown as Deps['db'];
}

const baseConfig = {
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
  DISCORD_BOT_TOKEN: 'fake-token',
  DISCORD_PUBLIC_KEY: 'test-public-key',
  DISCORD_APP_ID: 'test-app-id',
  DISCORD_CHANNEL_MAP: undefined,
  DISCORD_ENABLED: true,
  INVESTIGATOR_JOB_NAME: 'sower-investigator',
  SCREENSHOT_INVESTIGATION_ENABLED: false,
} as Config;

function createNotify(): Notifier {
  return {
    postApprovalCard: vi.fn(async () => ({
      channelId: 'chan-1',
      messageId: 'msg-1',
    })),
    postOtpRequestCard: vi.fn(async () => ({
      channelId: 'chan-otp',
      messageId: 'msg-otp',
    })),
    updateApprovalCard: vi.fn(async () => {}),
    verifyInteraction: vi.fn(() => true),
    applyVerdict: vi.fn(() => ({ embeds: [], components: [] })),
    fetchChannelMessages: vi.fn(async () => []),
    addReaction: vi.fn(async () => {}),
    postChannelMessage: vi.fn(async () => ({ id: 'reply-1' })),
    editChannelMessage: vi.fn(async () => {}),
    getChannelMessage: vi.fn(async () => ({ id: 'reply-1' })),
    deleteChannelMessage: vi.fn(async () => {}),
  };
}

function createDeps(
  state: FakeState,
  overrides: { discordEnabled?: boolean; notify?: Notifier } = {},
) {
  const notify = overrides.notify ?? createNotify();
  const deps: Deps = {
    db: createFakeDb(state),
    queue: { enqueueProcess: vi.fn(async () => {}) },
    config: {
      ...baseConfig,
      DISCORD_ENABLED: overrides.discordEnabled ?? true,
    },
    notify,
    logger: false,
  };
  return { deps, notify };
}

describe('normalizeOtp', () => {
  it('accepts 4-10 alphanumerics and strips spaces/dashes', () => {
    expect(normalizeOtp('482913')).toBe('482913');
    expect(normalizeOtp('123 456')).toBe('123456');
    expect(normalizeOtp('123-456')).toBe('123456');
    expect(normalizeOtp('AB12CD')).toBe('AB12CD');
  });

  it('rejects garbage', () => {
    expect(normalizeOtp('123')).toBeNull();
    expect(normalizeOtp('12345678901')).toBeNull();
    expect(normalizeOtp('12 34; DROP')).toBeNull();
    expect(normalizeOtp('')).toBeNull();
  });
});

describe('requestOtp', () => {
  it('parks a FILLING task in AWAITING_OTP, records NEED_OTP, posts the card', async () => {
    const state = createState('FILLING');
    const { deps, notify } = createDeps(state);

    const outcome = await requestOtp(deps, TASK_ID);

    expect(outcome).toEqual({ kind: 'requested', state: 'AWAITING_OTP' });
    expect(state.task?.state).toBe('AWAITING_OTP');
    expect(state.task?.otpRequestedAt).toBeInstanceOf(Date);
    expect(state.events).toEqual([
      expect.objectContaining({
        type: 'NEED_OTP',
        fromState: 'FILLING',
        toState: 'AWAITING_OTP',
      }),
    ]);
    expect(notify.postOtpRequestCard).toHaveBeenCalledWith({
      taskId: TASK_ID,
      platform: 'workday',
      company: 'Cadence',
      title: 'Software Intern',
      tenant: 'cadence',
    });
    // Card ref persisted so submitOtp can edit it later.
    expect(state.task?.otpChannelId).toBe('chan-otp');
    expect(state.task?.otpMessageId).toBe('msg-otp');
  });

  it('skips a task that is not FILLING (no event, no card)', async () => {
    const state = createState('REVIEW');
    const { deps, notify } = createDeps(state);

    const outcome = await requestOtp(deps, TASK_ID);

    expect(outcome).toEqual({ kind: 'skipped', state: 'REVIEW' });
    expect(state.events).toHaveLength(0);
    expect(notify.postOtpRequestCard).not.toHaveBeenCalled();
  });

  it('returns not_found for a missing task', async () => {
    const state = createState();
    state.task = null;
    const { deps } = createDeps(state);
    expect(await requestOtp(deps, TASK_ID)).toEqual({ kind: 'not_found' });
  });

  it('still parks the task when Discord is disabled (transition is the contract)', async () => {
    const state = createState('FILLING');
    const { deps, notify } = createDeps(state, { discordEnabled: false });

    const outcome = await requestOtp(deps, TASK_ID);

    expect(outcome.kind).toBe('requested');
    expect(state.task?.state).toBe('AWAITING_OTP');
    expect(notify.postOtpRequestCard).not.toHaveBeenCalled();
  });

  it('still parks the task when the card post fails (best-effort)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const state = createState('FILLING');
    const notify = createNotify();
    (notify.postOtpRequestCard as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('discord down'),
    );
    const { deps } = createDeps(state, { notify });

    const outcome = await requestOtp(deps, TASK_ID);

    expect(outcome.kind).toBe('requested');
    expect(state.task?.state).toBe('AWAITING_OTP');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('submitOtp', () => {
  it('stores the normalized code, resumes FILLING, records RETRY, edits the card', async () => {
    const state = createState('AWAITING_OTP');
    if (state.task) {
      state.task.otpChannelId = 'chan-otp';
      state.task.otpMessageId = 'msg-otp';
    }
    const { deps, notify } = createDeps(state);

    const outcome = await submitOtp(deps, TASK_ID, '482 913');

    expect(outcome).toEqual({ kind: 'submitted', state: 'FILLING' });
    expect(state.task?.state).toBe('FILLING');
    expect(state.task?.pendingOtp).toBe('482913');
    expect(state.task?.otpSubmittedAt).toBeInstanceOf(Date);
    expect(state.events).toEqual([
      expect.objectContaining({
        type: 'RETRY',
        fromState: 'AWAITING_OTP',
        toState: 'FILLING',
        data: { via: 'otp' },
      }),
    ]);
    expect(notify.updateApprovalCard).toHaveBeenCalledWith(
      'chan-otp',
      'msg-otp',
      'otp-received',
      'task resumed',
    );
  });

  it('the code never lands in the events row', async () => {
    const state = createState('AWAITING_OTP');
    const { deps } = createDeps(state);

    await submitOtp(deps, TASK_ID, '482913');

    expect(JSON.stringify(state.events)).not.toContain('482913');
  });

  it('rejects an invalid code without touching state', async () => {
    const state = createState('AWAITING_OTP');
    const { deps } = createDeps(state);

    const outcome = await submitOtp(deps, TASK_ID, 'not a code!!');

    expect(outcome).toEqual({ kind: 'invalid_code' });
    expect(state.task?.state).toBe('AWAITING_OTP');
    expect(state.events).toHaveLength(0);
  });

  it('skips a task that is not AWAITING_OTP', async () => {
    const state = createState('REVIEW');
    const { deps } = createDeps(state);
    expect(await submitOtp(deps, TASK_ID, '482913')).toEqual({
      kind: 'skipped',
      state: 'REVIEW',
    });
  });

  it('returns not_found for a missing task', async () => {
    const state = createState();
    state.task = null;
    const { deps } = createDeps(state);
    expect(await submitOtp(deps, TASK_ID, '482913')).toEqual({
      kind: 'not_found',
    });
  });
});

describe('consumePendingOtp', () => {
  it('returns the code exactly once (compare-and-clear)', async () => {
    const state = createState('FILLING');
    if (state.task) {
      state.task.pendingOtp = '482913';
    }
    const { deps } = createDeps(state);

    expect(await consumePendingOtp(deps, TASK_ID)).toBe('482913');
    expect(state.task?.pendingOtp).toBeNull();
    expect(await consumePendingOtp(deps, TASK_ID)).toBeNull();
  });

  it('returns null when no code is pending', async () => {
    const state = createState('FILLING');
    const { deps } = createDeps(state);
    expect(await consumePendingOtp(deps, TASK_ID)).toBeNull();
  });
});
