import { apiCalls, applicationTasks, documents, events, jobs } from '@sower/db';
import type { ApprovalMessagePayload, ApprovalVerdict } from '@sower/notify';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Config } from './config.js';
import { buildServer } from './server.js';
import type { Deps, Notifier } from './types.js';

/**
 * POST /discord/interactions tests. Like task-actions.test.ts these run
 * through buildServer with the REAL @sower/core state machine and the REAL
 * @sower/platforms GreenhouseAdapter (no vi.mock), so the approve-button
 * test's "fetch is never called" assertion covers the genuine dry-run path.
 * Signature crypto itself is covered in @sower/notify; here verifyInteraction
 * is injected so both verdicts (valid/invalid) are exercised.
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

/** Stateful fake db dispatching on the actual drizzle table objects. */
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
              // submitOtp's resume claim also carries pendingOtp; approve's
              // REVIEW claim never does — that key tells the two apart.
              const claimable =
                setArg.state === 'QUEUED'
                  ? task.state === 'NEEDS_INPUT' || task.state === 'FAILED'
                  : setArg.state === 'FILLING'
                    ? 'pendingOtp' in setArg
                      ? task.state === 'AWAITING_OTP'
                      : task.state === 'REVIEW'
                    : setArg.state === 'AWAITING_OTP'
                      ? task.state === 'FILLING'
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

/**
 * Fake Notifier: verifyInteraction verdict is configurable; applyVerdict
 * mirrors the real builder's observable behavior (append verdict line,
 * disable every button) so type-7 payload assertions stay meaningful.
 */
function createNotify(options: { verified?: boolean } = {}) {
  const verified = options.verified ?? true;
  const notify = {
    verifyInteraction: vi.fn(
      (
        _publicKey: string,
        _signature: string,
        _timestamp: string,
        _rawBody: string | Buffer | Uint8Array,
      ) => verified,
    ),
    postApprovalCard: vi.fn(async () => ({
      channelId: 'chan-1',
      messageId: 'msg-1',
    })),
    postOtpRequestCard: vi.fn(async () => ({
      channelId: 'chan-1',
      messageId: 'otp-msg-1',
    })),
    updateApprovalCard: vi.fn(async () => {}),
    applyVerdict: vi.fn(
      (
        existing: Partial<ApprovalMessagePayload>,
        verdict: ApprovalVerdict,
        detail?: string,
      ): ApprovalMessagePayload => ({
        embeds: [{ description: detail ? `${verdict}: ${detail}` : verdict }],
        components: (existing.components ?? []).map((row) => ({
          ...row,
          components: row.components.map((button) => ({
            ...button,
            disabled: true,
          })),
        })),
      }),
    ),
    fetchChannelMessages: vi.fn(async () => []),
    addReaction: vi.fn(async () => {}),
    postChannelMessage: vi.fn(async () => {}),
  } satisfies Notifier;
  return notify;
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

/** The original approval card the buttons live on (echoed by Discord). */
function cardMessage() {
  return {
    embeds: [{ title: 'Acme — Software Engineer Intern' }],
    components: [
      {
        type: 1,
        components: [
          { type: 2, style: 3, custom_id: `approve:${TASK_ID}` },
          { type: 2, style: 4, custom_id: `reject:${TASK_ID}` },
        ],
      },
    ],
  };
}

function postInteraction(
  app: FastifyInstance,
  body: unknown,
  headers: Record<string, string | undefined> = {},
) {
  const cleanHeaders: Record<string, string> = {
    'content-type': 'application/json',
    'x-signature-ed25519': 'test-signature',
    'x-signature-timestamp': 'test-timestamp',
  };
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) {
      delete cleanHeaders[key];
    } else {
      cleanHeaders[key] = value;
    }
  }
  return app.inject({
    method: 'POST',
    url: '/discord/interactions',
    payload: typeof body === 'string' ? body : JSON.stringify(body),
    headers: cleanHeaders,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('POST /discord/interactions', () => {
  it('answers PING with PONG and verifies the signature over the RAW body', async () => {
    const notify = createNotify();
    const { deps } = createDeps(createState(), { notify });
    const app = buildServer(deps);

    // Odd spacing survives only if the raw bytes (not re-serialized JSON)
    // are handed to signature verification.
    const rawBody = '{ "type" :  1 }';
    const res = await postInteraction(app, rawBody);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ type: 1 });

    expect(notify.verifyInteraction).toHaveBeenCalledTimes(1);
    const [publicKey, signature, timestamp, raw] =
      notify.verifyInteraction.mock.calls[0] ?? [];
    expect(publicKey).toBe('test-public-key');
    expect(signature).toBe('test-signature');
    expect(timestamp).toBe('test-timestamp');
    expect(Buffer.isBuffer(raw)).toBe(true);
    expect((raw as Buffer).toString('utf8')).toBe(rawBody);
  });

  it('does NOT require the x-api-key (signature auth replaces it) while other routes still do', async () => {
    const notify = createNotify();
    const { deps } = createDeps(createState(), { notify });
    const app = buildServer(deps);

    // No x-api-key header at all: still accepted (signature-verified).
    const ping = await postInteraction(app, { type: 1 });
    expect(ping.statusCode).toBe(200);

    // The rest of the API keeps the x-api-key guard.
    const tasks = await app.inject({ method: 'GET', url: '/tasks' });
    expect(tasks.statusCode).toBe(401);
    expect(tasks.json()).toEqual({ error: 'unauthorized' });
  });

  it('rejects an invalid signature with 401 and does nothing', async () => {
    const notify = createNotify({ verified: false });
    const state = createState();
    const { deps } = createDeps(state, { notify });
    const app = buildServer(deps);

    const res = await postInteraction(app, {
      type: 3,
      data: { custom_id: `approve:${TASK_ID}` },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'invalid request signature' });
    expect(state.events).toHaveLength(0);
    expect(state.task?.state).toBe('REVIEW');
  });

  it('rejects a request missing the signature headers with 401 without verifying', async () => {
    const notify = createNotify();
    const { deps } = createDeps(createState(), { notify });
    const app = buildServer(deps);

    const res = await postInteraction(
      app,
      { type: 1 },
      { 'x-signature-ed25519': undefined },
    );

    expect(res.statusCode).toBe(401);
    expect(notify.verifyInteraction).not.toHaveBeenCalled();
  });

  it('responds 503 when no notifier is wired (still exempt from the api-key guard)', async () => {
    const { deps } = createDeps(createState()); // no notify
    const app = buildServer(deps);

    const res = await postInteraction(app, { type: 1 });

    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({
      error: 'discord interactions not configured',
    });
  });

  it('approve button: dry-run submit with ZERO network I/O, then a type-7 card edit', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('SAFETY VIOLATION: fetch called during approve dry-run');
    });
    const notify = createNotify();
    const state = createState({ state: 'REVIEW' });
    const { deps } = createDeps(state, { notify });
    const app = buildServer(deps);

    const res = await postInteraction(app, {
      type: 3,
      data: { custom_id: `approve:${TASK_ID}` },
      message: cardMessage(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.type).toBe(7); // UPDATE_MESSAGE: edits the card in place

    // SAFETY: the entire approve path performed no HTTP request.
    expect(fetchSpy).not.toHaveBeenCalled();
    // No bot-token call either: type 7 already edits the message.
    expect(notify.updateApprovalCard).not.toHaveBeenCalled();

    // The same state machine walk as POST /tasks/:id/approve.
    expect(state.task?.state).toBe('REVIEW');
    expect(state.events.map((e) => [e.type, e.fromState, e.toState])).toEqual([
      ['APPROVED', 'REVIEW', 'FILLING'],
      ['FILLED', 'FILLING', 'REVIEW'],
    ]);

    // The dry-run payload representation was recorded.
    expect(state.apiCalls).toHaveLength(1);
    expect(state.apiCalls[0]).toMatchObject({
      taskId: TASK_ID,
      phase: 'submit_dryrun',
      dryRun: true,
    });

    // The card was edited via the shared verdict builder: approved + summary.
    expect(notify.applyVerdict).toHaveBeenCalledTimes(1);
    const [existing, verdict, detail] = notify.applyVerdict.mock.calls[0] ?? [];
    expect(verdict).toBe('approved');
    expect(detail).toContain('Dry-run submit recorded (2 field(s), 1 file(s))');
    expect(detail).toContain('no real application was sent');
    expect(existing).toEqual(cardMessage());
    // Every button in the edited message is disabled.
    const buttons = body.data.components.flatMap(
      (row: { components: Array<{ disabled?: boolean }> }) => row.components,
    );
    expect(buttons.length).toBeGreaterThan(0);
    for (const button of buttons) {
      expect(button.disabled).toBe(true);
    }
  });

  it('approve button on a non-REVIEW task: ephemeral notice, no state change', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('SAFETY VIOLATION: fetch called during approve');
    });
    const notify = createNotify();
    const state = createState({ state: 'NEEDS_INPUT' });
    const { deps } = createDeps(state, { notify });
    const app = buildServer(deps);

    const res = await postInteraction(app, {
      type: 3,
      data: { custom_id: `approve:${TASK_ID}` },
      message: cardMessage(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.type).toBe(4); // ephemeral notice, card untouched
    expect(body.data.flags).toBe(64);
    expect(body.data.content).toContain('NEEDS_INPUT');
    expect(state.task?.state).toBe('NEEDS_INPUT');
    expect(state.events).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('reject button: records a REJECTED event WITHOUT changing state, then a type-7 card edit', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('SAFETY VIOLATION: fetch called during reject');
    });
    const notify = createNotify();
    const state = createState({ state: 'REVIEW' });
    const { deps } = createDeps(state, { notify });
    const app = buildServer(deps);

    const res = await postInteraction(app, {
      type: 3,
      data: { custom_id: `reject:${TASK_ID}` },
      message: cardMessage(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.type).toBe(7);

    // Reject is a review verdict, not a transition: state is unchanged.
    expect(state.task?.state).toBe('REVIEW');
    expect(state.events).toHaveLength(1);
    expect(state.events[0]).toMatchObject({
      taskId: TASK_ID,
      type: 'REJECTED',
      fromState: 'REVIEW',
      toState: 'REVIEW',
      data: { via: 'discord' },
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(state.apiCalls).toHaveLength(0);
    const [, verdict] = notify.applyVerdict.mock.calls[0] ?? [];
    expect(verdict).toBe('rejected');
  });

  it('rejects unknown custom_ids and non-uuid task ids with 400', async () => {
    const notify = createNotify();
    const state = createState();
    const { deps } = createDeps(state, { notify });
    const app = buildServer(deps);

    for (const customId of ['nuke:everything', 'approve:not-a-uuid', '']) {
      const res = await postInteraction(app, {
        type: 3,
        data: { custom_id: customId },
      });
      expect(res.statusCode).toBe(400);
    }
    expect(state.events).toHaveLength(0);
  });

  it('rejects unsupported interaction types with 400', async () => {
    const notify = createNotify();
    const { deps } = createDeps(createState(), { notify });
    const app = buildServer(deps);

    const res = await postInteraction(app, { type: 2 });

    expect(res.statusCode).toBe(400);
  });

  it('otp button: opens a modal (type 9) with a single code input, no state change', async () => {
    const notify = createNotify();
    const state = createState({ state: 'AWAITING_OTP' });
    const { deps } = createDeps(state, { notify });
    const app = buildServer(deps);

    const res = await postInteraction(app, {
      type: 3,
      data: { custom_id: `otp:${TASK_ID}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      type: number;
      data: { custom_id: string; components: unknown[] };
    };
    expect(body.type).toBe(9);
    expect(body.data.custom_id).toBe(`otp-modal:${TASK_ID}`);
    expect(body.data.components).toHaveLength(1);
    expect(state.task?.state).toBe('AWAITING_OTP');
    expect(state.events).toHaveLength(0);
  });

  it('otp modal submit: stores the code, resumes FILLING (RETRY), type-7 card edit', async () => {
    const notify = createNotify();
    const state = createState({ state: 'AWAITING_OTP' });
    const { deps } = createDeps(state, { notify });
    const app = buildServer(deps);

    const res = await postInteraction(app, {
      type: 5,
      data: {
        custom_id: `otp-modal:${TASK_ID}`,
        components: [
          { components: [{ custom_id: 'otp_code', value: '482 913' }] },
        ],
      },
      message: cardMessage(),
    });

    expect(res.statusCode).toBe(200);
    expect((res.json() as { type: number }).type).toBe(7);
    expect(state.task?.state).toBe('FILLING');
    expect(state.task?.pendingOtp).toBe('482913');
    expect(state.events).toEqual([
      expect.objectContaining({
        type: 'RETRY',
        fromState: 'AWAITING_OTP',
        toState: 'FILLING',
      }),
    ]);
    const [, verdict] = notify.applyVerdict.mock.calls[0] ?? [];
    expect(verdict).toBe('otp-received');
  });

  it('otp modal submit with a garbage code: ephemeral notice, task untouched', async () => {
    const notify = createNotify();
    const state = createState({ state: 'AWAITING_OTP' });
    const { deps } = createDeps(state, { notify });
    const app = buildServer(deps);

    const res = await postInteraction(app, {
      type: 5,
      data: {
        custom_id: `otp-modal:${TASK_ID}`,
        components: [
          { components: [{ custom_id: 'otp_code', value: 'nope!!' }] },
        ],
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { type: number; data: { flags: number } };
    expect(body.type).toBe(4);
    expect(body.data.flags).toBe(64);
    expect(state.task?.state).toBe('AWAITING_OTP');
    expect(state.events).toHaveLength(0);
  });

  it('otp modal submit on a non-AWAITING_OTP task: ephemeral notice', async () => {
    const notify = createNotify();
    const state = createState({ state: 'REVIEW' });
    const { deps } = createDeps(state, { notify });
    const app = buildServer(deps);

    const res = await postInteraction(app, {
      type: 5,
      data: {
        custom_id: `otp-modal:${TASK_ID}`,
        components: [
          { components: [{ custom_id: 'otp_code', value: '482913' }] },
        ],
      },
    });

    expect(res.statusCode).toBe(200);
    expect((res.json() as { type: number }).type).toBe(4);
    expect(state.task?.state).toBe('REVIEW');
  });

  it('rejects a modal submit with an unknown custom_id with 400', async () => {
    const notify = createNotify();
    const { deps } = createDeps(createState(), { notify });
    const app = buildServer(deps);

    const res = await postInteraction(app, {
      type: 5,
      data: { custom_id: 'evil-modal:whatever' },
    });

    expect(res.statusCode).toBe(400);
  });
});
