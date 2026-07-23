import type { DiscordEmbed } from '@sower/notify';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from './config.js';
import { buildWeeklyDigest, runWeeklyDigest } from './digest.js';
import type { Deps, Notifier } from './types.js';

interface Chain {
  from: () => Chain;
  where: () => Chain;
  limit: () => Chain;
  innerJoin: () => Chain;
  orderBy: () => Chain;
  values: (arg?: unknown) => Chain;
  returning: () => Chain;
  set: (arg?: unknown) => Chain;
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

const baseConfig: Config = {
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
  SOURCE_INVESTIGATE_PER_RUN: 5,
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
  CALENDAR_SYNC_ENABLED: false,
  DASHBOARD_BASE_URL: 'https://dash.example',
};

function createNotify(): Notifier {
  return {
    postChannelMessage: vi.fn(async () => ({ id: 'msg-1' })),
  } as unknown as Notifier;
}

function createDeps(overrides: {
  config?: Partial<Config>;
  db?: Deps['db'];
  notify?: Notifier | undefined;
}): Deps {
  return {
    db: overrides.db ?? createFakeDb(),
    queue: { enqueueProcess: vi.fn(async () => {}) },
    config: { ...baseConfig, ...overrides.config },
    ...('notify' in overrides ? { notify: overrides.notify } : {}),
    logger: false,
  };
}

/** Noon ET on Saturday July 18, 2026 — the digest's injected clock. */
const NOW = new Date('2026-07-18T16:00:00Z');

const T1 = 'aaaaaaaa-0000-4000-8000-000000000001';
const T2 = 'aaaaaaaa-0000-4000-8000-000000000002';
const W1 = 'aaaaaaaa-0000-4000-8000-000000000011';
const W2 = 'aaaaaaaa-0000-4000-8000-000000000012';
const W3 = 'aaaaaaaa-0000-4000-8000-000000000013';
const D1 = 'aaaaaaaa-0000-4000-8000-000000000021';
const D2 = 'aaaaaaaa-0000-4000-8000-000000000022';
const F1 = 'bbbbbbbb-0000-4000-8000-000000000001';
const F2 = 'bbbbbbbb-0000-4000-8000-000000000002';

/**
 * The builder's six selects, in order: submitted-entering events, created
 * tasks, DISCARD events, waiting tasks, deadline-carrying tasks, open
 * follow-ups.
 */
function fullSelectResults(): unknown[][] {
  return [
    // 1) Events entering SUBMITTED/CONFIRMED (joined to task+job).
    [
      // T1 entered twice (SUBMIT_OK then CONFIRM) — counts once, earliest.
      {
        taskId: T1,
        toState: 'SUBMITTED',
        at: new Date('2026-07-15T12:00:00Z'),
        state: 'CONFIRMED',
        company: 'Acme',
        title: 'SWE Intern',
      },
      {
        taskId: T1,
        toState: 'CONFIRMED',
        at: new Date('2026-07-16T12:00:00Z'),
        state: 'CONFIRMED',
        company: 'Acme',
        title: 'SWE Intern',
      },
      {
        taskId: T2,
        toState: 'SUBMITTED',
        at: new Date('2026-07-17T12:00:00Z'),
        state: 'SUBMITTED',
        company: 'Globex',
        title: null,
      },
      // Out of the trailing window — belt-filtered.
      {
        taskId: 'aaaaaaaa-0000-4000-8000-000000000003',
        toState: 'SUBMITTED',
        at: new Date('2026-07-01T12:00:00Z'),
        state: 'SUBMITTED',
        company: 'Old',
        title: null,
      },
      // Un-marked afterwards (current state left SUBMITTED) — not "sent".
      {
        taskId: 'aaaaaaaa-0000-4000-8000-000000000004',
        toState: 'SUBMITTED',
        at: new Date('2026-07-16T12:00:00Z'),
        state: 'NEEDS_INPUT',
        company: 'Undo',
        title: null,
      },
    ],
    // 2) Tasks created (one out-of-window row belt-filtered).
    [
      { createdAt: new Date('2026-07-14T12:00:00Z') },
      { createdAt: new Date('2026-07-16T12:00:00Z') },
      { createdAt: new Date('2026-07-01T12:00:00Z') },
    ],
    // 3) DISCARD events: only in-window reason 'auto' counts.
    [
      { data: { reason: 'auto' }, at: new Date('2026-07-15T12:00:00Z') },
      { data: { reason: 'manual' }, at: new Date('2026-07-15T12:00:00Z') },
      { data: { reason: 'auto' }, at: new Date('2026-07-01T12:00:00Z') },
    ],
    // 4) Waiting (NEEDS_INPUT/REVIEW) tasks joined to jobs.
    [
      {
        taskId: W1,
        state: 'NEEDS_INPUT',
        priority: 0,
        createdAt: new Date('2026-07-05T12:00:00Z'),
        updatedAt: new Date('2026-07-05T12:00:00Z'),
        dueDate: null,
        deadline: null,
        company: 'Stale Co',
        title: 'Old Role',
      },
      {
        taskId: W2,
        state: 'REVIEW',
        priority: 2,
        createdAt: new Date('2026-07-17T12:00:00Z'),
        updatedAt: new Date('2026-07-17T12:00:00Z'),
        dueDate: new Date('2026-07-20T04:00:00Z'),
        deadline: new Date('2026-09-01T04:00:00Z'),
        company: 'Acme',
        title: 'SWE Intern',
      },
      {
        taskId: W3,
        state: 'NEEDS_INPUT',
        priority: 0,
        createdAt: new Date('2026-07-16T12:00:00Z'),
        updatedAt: new Date('2026-07-16T12:00:00Z'),
        dueDate: null,
        deadline: new Date('2026-07-22T04:00:00Z'),
        company: 'Globex',
        title: 'Data Intern',
      },
    ],
    // 5) Deadline-carrying tasks.
    [
      {
        taskId: D1,
        state: 'NEEDS_INPUT',
        // The user's due date WINS over the posting deadline.
        dueDate: new Date('2026-07-20T04:00:00Z'),
        deadline: new Date('2026-09-01T04:00:00Z'),
        company: 'Acme',
        title: 'SWE Intern',
      },
      {
        taskId: D2,
        state: 'REVIEW',
        // Due TODAY (ET) — still this week.
        dueDate: new Date('2026-07-18T04:00:00Z'),
        deadline: null,
        company: 'Initech',
        title: 'PM Intern',
      },
      {
        // Beyond the 7-ET-day horizon.
        taskId: 'aaaaaaaa-0000-4000-8000-000000000023',
        state: 'NEEDS_INPUT',
        dueDate: null,
        deadline: new Date('2026-08-30T04:00:00Z'),
        company: 'Far',
        title: 'Later',
      },
      {
        // Exactly the horizon date (now + 7 days) — next week's digest.
        taskId: 'aaaaaaaa-0000-4000-8000-000000000024',
        state: 'REVIEW',
        dueDate: new Date('2026-07-25T04:00:00Z'),
        deadline: null,
        company: 'Edge',
        title: 'Boundary',
      },
      {
        // Sent already — its deadline means nothing (belt-filtered).
        taskId: 'aaaaaaaa-0000-4000-8000-000000000025',
        state: 'SUBMITTED',
        dueDate: new Date('2026-07-19T04:00:00Z'),
        deadline: null,
        company: 'Done',
        title: 'Sent',
      },
    ],
    // 6) Open follow-ups joined to parent task+job.
    [
      {
        followupId: F1,
        kind: 'assessment',
        title: 'HackerRank OA',
        state: 'ACTION_NEEDED',
        dueDate: new Date('2026-07-22T04:00:00Z'),
        company: 'Akuna Capital',
      },
      {
        followupId: F2,
        kind: 'interview',
        title: 'Phone screen',
        state: 'SCHEDULED',
        dueDate: null,
        company: 'Acme',
      },
      {
        // Terminal — belt-filtered out of both in-play and deadlines.
        followupId: 'bbbbbbbb-0000-4000-8000-000000000003',
        kind: 'other',
        title: 'Old thread',
        state: 'DONE',
        dueDate: new Date('2026-07-20T04:00:00Z'),
        company: 'Acme',
      },
    ],
  ];
}

describe('buildWeeklyDigest', () => {
  it('assembles the full week: submitted, ingested, waiting, deadlines, in play, stale', async () => {
    const db = createFakeDb({ selectResults: fullSelectResults() });

    const digest = await buildWeeklyDigest(db, NOW);

    // Submitted: T1 deduped to its earliest entry, out-of-window and
    // un-marked rows dropped, ordered oldest → newest.
    expect(digest.submitted.count).toBe(2);
    expect(digest.submitted.items).toEqual([
      {
        taskId: T1,
        company: 'Acme',
        title: 'SWE Intern',
        at: new Date('2026-07-15T12:00:00Z'),
      },
      {
        taskId: T2,
        company: 'Globex',
        title: null,
        at: new Date('2026-07-17T12:00:00Z'),
      },
    ]);

    expect(digest.ingested).toEqual({ created: 2, autoDiscarded: 1 });

    // Waiting: priority desc, then created desc; effective deadline shown.
    expect(digest.waiting.count).toBe(3);
    expect(digest.waiting.top.map((item) => item.taskId)).toEqual([W2, W3, W1]);
    expect(digest.waiting.top[0]).toEqual({
      taskId: W2,
      company: 'Acme',
      title: 'SWE Intern',
      priority: 2,
      due: new Date('2026-07-20T04:00:00Z'),
    });

    // Deadlines: today counts, the +7-day boundary and sent tasks don't;
    // tasks and follow-ups merge sorted soonest-first.
    expect(digest.deadlines.map((item) => [item.kind, item.id])).toEqual([
      ['task', D2],
      ['task', D1],
      ['followup', F1],
    ]);
    expect(digest.deadlines[2]).toEqual({
      kind: 'followup',
      id: F1,
      company: 'Akuna Capital',
      title: 'HackerRank OA',
      due: new Date('2026-07-22T04:00:00Z'),
    });

    // In play: open follow-ups grouped by state; DONE never appears.
    expect(digest.inPlay.count).toBe(2);
    expect(digest.inPlay.byState).toEqual({
      ACTION_NEEDED: [
        {
          followupId: F1,
          kind: 'assessment',
          company: 'Akuna Capital',
          title: 'HackerRank OA',
        },
      ],
      SCHEDULED: [
        {
          followupId: F2,
          kind: 'interview',
          company: 'Acme',
          title: 'Phone screen',
        },
      ],
    });

    // Stale: only the NEEDS_INPUT row untouched for over a week.
    expect(digest.stale).toEqual({
      count: 1,
      oldest: [
        { taskId: W1, company: 'Stale Co', title: 'Old Role', days: 13 },
      ],
    });
  });

  it('an empty pipeline yields a digest of zeros (no crashes, no nulls)', async () => {
    const digest = await buildWeeklyDigest(createFakeDb(), NOW);
    expect(digest).toEqual({
      now: NOW,
      submitted: { count: 0, items: [] },
      ingested: { created: 0, autoDiscarded: 0 },
      waiting: { count: 0, top: [] },
      deadlines: [],
      inPlay: { count: 0, byState: {} },
      stale: { count: 0, oldest: [] },
    });
  });

  it('caps the waiting top slice at 5 and the stale list at 3', async () => {
    const waitingRows = Array.from({ length: 8 }, (_, i) => ({
      taskId: `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, '0')}`,
      state: 'NEEDS_INPUT',
      priority: 0,
      createdAt: new Date('2026-07-01T12:00:00Z'),
      updatedAt: new Date(`2026-07-0${i + 1}T12:00:00Z`),
      dueDate: null,
      deadline: null,
      company: `Co ${i}`,
      title: null,
    }));
    const db = createFakeDb({
      selectResults: [[], [], [], waitingRows, [], []],
    });

    const digest = await buildWeeklyDigest(db, NOW);

    expect(digest.waiting.count).toBe(8);
    expect(digest.waiting.top).toHaveLength(5);
    // All 8 rows were last touched July 1–8 — over a week before the 18th.
    expect(digest.stale.count).toBe(8);
    expect(digest.stale.oldest).toHaveLength(3);
    // Oldest first.
    expect(digest.stale.oldest.map((item) => item.days)).toEqual([17, 16, 15]);
  });
});

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SEND_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';

/**
 * Fake fetch for the email leg: serves the OAuth token endpoint, records
 * every Gmail send call, and answers each from the provided queue.
 */
function createFetch(responses: Response[] = []) {
  const queue = [...responses];
  const sends: { url: string; body: string }[] = [];
  const fetchImpl = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === TOKEN_URL) {
        return new Response(
          JSON.stringify({ access_token: 'tok-1', expires_in: 3600 }),
          { status: 200 },
        );
      }
      sends.push({ url, body: String(init?.body ?? '') });
      const next = queue.shift();
      if (!next) {
        throw new Error(`unexpected fetch ${url}`);
      }
      return next;
    },
  ) as unknown as typeof fetch;
  return { fetchImpl, sends };
}

/** Config overrides that fully enable the email leg. */
const emailConfig: Partial<Config> = {
  DIGEST_EMAIL_TO: 'me@example.com',
  GMAIL_CLIENT_ID: 'cid',
  GMAIL_CLIENT_SECRET: 'csec',
  GMAIL_REFRESH_TOKEN: 'rtok',
};

/** Config overrides that fully enable the Discord leg. */
const discordConfig: Partial<Config> = {
  DISCORD_BOT_TOKEN: 'token',
  DISCORD_ENABLED: true,
  DISCORD_DIGEST_CHANNEL_ID: 'chan-digest',
};

describe('runWeeklyDigest', () => {
  // Failure-path tests log via console.warn — silence it per test.
  beforeEach(() => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    return () => warn.mockRestore();
  });

  it('skips both legs (with reasons) when neither is configured', async () => {
    const { fetchImpl } = createFetch();
    const result = await runWeeklyDigest(
      createDeps({ notify: undefined }),
      NOW,
      fetchImpl,
    );
    expect(result).toEqual({
      discord: 'skipped: no Discord digest channel configured',
      email: 'skipped: no digest email recipient configured',
      week: { submitted: 0, ingested: 0, deadlines: 0, inPlay: 0 },
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('posts the digest to the Discord channel when only that leg is configured', async () => {
    const notify = createNotify();
    const { fetchImpl } = createFetch();
    const deps = createDeps({
      db: createFakeDb({ selectResults: fullSelectResults() }),
      config: discordConfig,
      notify,
    });

    const result = await runWeeklyDigest(deps, NOW, fetchImpl);

    expect(result.discord).toBe('sent');
    expect(result.email).toBe('skipped: no digest email recipient configured');
    expect(result.week).toEqual({
      submitted: 2,
      ingested: 2,
      deadlines: 3,
      inPlay: 2,
    });
    expect(notify.postChannelMessage).toHaveBeenCalledTimes(1);
    const [channelId, message] = vi.mocked(notify.postChannelMessage).mock
      .calls[0] as [string, { embeds: DiscordEmbed[] }];
    expect(channelId).toBe('chan-digest');
    // The Discord leg posts the digest as ONE rich embed.
    const embed = message.embeds[0];
    expect(message.embeds).toHaveLength(1);
    expect(embed?.title).toContain('Sower weekly');
    expect(embed?.color).toBe(0x5865f2);
    expect(embed?.timestamp).toBe(NOW.toISOString());
    expect(
      embed?.fields?.some((field) => field.name === '📤 Submitted (2)'),
    ).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('sends both legs when both are configured (one digest build, zero writes)', async () => {
    const writes: DbWrite[] = [];
    const notify = createNotify();
    const { fetchImpl, sends } = createFetch([
      new Response(JSON.stringify({ id: 'sent-1' }), { status: 200 }),
    ]);
    const deps = createDeps({
      db: createFakeDb({ selectResults: fullSelectResults(), writes }),
      config: { ...discordConfig, ...emailConfig },
      notify,
    });

    const result = await runWeeklyDigest(deps, NOW, fetchImpl);

    expect(result.discord).toBe('sent');
    expect(result.email).toBe('sent');
    expect(sends).toEqual([
      { url: SEND_URL, body: expect.stringContaining('"raw"') },
    ]);
    // The MIME message went to the configured recipient.
    const { raw } = JSON.parse(sends[0]?.body ?? '{}') as { raw: string };
    expect(Buffer.from(raw, 'base64url').toString('utf8')).toContain(
      'To: me@example.com',
    );
    // Read-only by contract: the run never mutates state.
    expect(writes).toEqual([]);
  });

  it("reports the email leg 'skipped: token lacks send scope' on a 403", async () => {
    const { fetchImpl } = createFetch([new Response('{}', { status: 403 })]);
    const result = await runWeeklyDigest(
      createDeps({ notify: undefined, config: emailConfig }),
      NOW,
      fetchImpl,
    );
    expect(result.email).toBe('skipped: token lacks send scope');
  });

  it('a failed email leg never blocks Discord (and vice versa)', async () => {
    // Email fails on the network; Discord still sends.
    const notify = createNotify();
    const brokenFetch = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === TOKEN_URL) {
        return new Response(
          JSON.stringify({ access_token: 'tok-1', expires_in: 3600 }),
          { status: 200 },
        );
      }
      throw new Error('ECONNRESET');
    }) as unknown as typeof fetch;
    const first = await runWeeklyDigest(
      createDeps({ config: { ...discordConfig, ...emailConfig }, notify }),
      NOW,
      brokenFetch,
    );
    expect(first.discord).toBe('sent');
    expect(first.email).toBe('failed: ECONNRESET');

    // Discord fails; the email leg still sends.
    const failingNotify = {
      postChannelMessage: vi.fn(async () => {
        throw new Error('discord 502');
      }),
    } as unknown as Notifier;
    const { fetchImpl } = createFetch([
      new Response(JSON.stringify({ id: 'sent-2' }), { status: 200 }),
    ]);
    const second = await runWeeklyDigest(
      createDeps({
        config: { ...discordConfig, ...emailConfig },
        notify: failingNotify,
      }),
      NOW,
      fetchImpl,
    );
    expect(second.discord).toBe('failed: discord 502');
    expect(second.email).toBe('sent');
  });

  it('a broken digest build is logged and reported on both legs, never thrown', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const db = {
      select: () => {
        throw new Error('db down');
      },
    } as unknown as Deps['db'];
    const { fetchImpl } = createFetch();
    const result = await runWeeklyDigest(
      createDeps({ db, notify: createNotify(), config: discordConfig }),
      NOW,
      fetchImpl,
    );
    expect(result).toEqual({
      discord: 'failed: digest build failed',
      email: 'failed: digest build failed',
      week: { submitted: 0, ingested: 0, deadlines: 0, inPlay: 0 },
    });
    expect(warn).toHaveBeenCalled();
  });
});
