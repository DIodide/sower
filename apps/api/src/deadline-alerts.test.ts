import { deadlineFromIsoDate } from '@sower/core';
import { events } from '@sower/db';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from './config.js';
import {
  DEADLINE_ALERT_EVENT,
  easternDateOf,
  runDeadlineAlerts,
  sendDeadlineAlert,
} from './deadline-alerts.js';
import type { Deps, Notifier } from './types.js';

/** What the mocked calendar reconcile reports + how it was called. */
const calendarState = vi.hoisted(() => ({
  calls: [] as Date[],
  result: { enabled: false, candidates: 0, synced: 0 },
}));

// The sweep itself is proven in calendar-sync.test.ts; here we only assert
// the alerts run invokes it (it self-gates and never throws).
vi.mock('./calendar-sync.js', () => ({
  reconcileCalendarEvents: vi.fn(async (_deps: unknown, now: Date) => {
    calendarState.calls.push(now);
    return calendarState.result;
  }),
}));

/** The reconcile result while calendar sync is unconfigured (the default). */
const DISABLED_CALENDAR = { enabled: false, candidates: 0, synced: 0 };

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
  DISCORD_BOT_TOKEN: 'test-token',
  DISCORD_PUBLIC_KEY: 'test-public-key',
  DISCORD_APP_ID: 'test-app-id',
  DISCORD_CHANNEL_MAP: undefined,
  DISCORD_INGEST_CHANNEL_ID: undefined,
  DISCORD_ALERTS_CHANNEL_ID: 'chan-alerts',
  DISCORD_ALERT_MENTION_USER_ID: '424242',
  DISCORD_ENABLED: true,
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
    notify: 'notify' in overrides ? overrides.notify : createNotify(),
    logger: false,
  };
}

/** 00:30 ET on July 18, 2026 (EDT, UTC-4) — just after the midnight run. */
const NOW = new Date('2026-07-18T04:30:00Z');
const TODAY_ET = '2026-07-18';

beforeEach(() => {
  calendarState.calls = [];
  calendarState.result = { ...DISABLED_CALENDAR };
});

/** A candidate row as the tasks+jobs join returns it. */
function row(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    taskId: 'aaaaaaaa-0000-4000-8000-000000000001',
    state: 'NEEDS_INPUT',
    dueDate: null,
    // UTC midnight July 19 = 8 PM ET July 18 → due on ET July 18.
    deadline: new Date('2026-07-19T00:00:00Z'),
    company: 'Acme',
    title: 'SWE Intern',
    url: 'https://job.example/x',
    ...overrides,
  };
}

describe('easternDateOf', () => {
  it('converts a UTC-midnight deadline to the PREVIOUS ET calendar date', () => {
    // 2026-07-19T00:00Z is 8 PM EDT on July 18 — the deadline instant falls
    // on ET July 18, so that is the day the midnight alert must fire.
    expect(easternDateOf(new Date('2026-07-19T00:00:00Z'))).toBe('2026-07-18');
  });

  it('handles the exact ET-midnight boundary in summer (EDT, UTC-4)', () => {
    expect(easternDateOf(new Date('2026-07-19T03:59:59Z'))).toBe('2026-07-18');
    expect(easternDateOf(new Date('2026-07-19T04:00:00Z'))).toBe('2026-07-19');
  });

  it('handles the ET-midnight boundary in winter (EST, UTC-5)', () => {
    expect(easternDateOf(new Date('2026-01-10T04:59:00Z'))).toBe('2026-01-09');
    expect(easternDateOf(new Date('2026-01-10T05:00:00Z'))).toBe('2026-01-10');
  });
});

describe('runDeadlineAlerts', () => {
  it('is a no-op {enabled:false} until the alerts channel is configured', async () => {
    const notify = createNotify();
    for (const config of [
      { DISCORD_ALERTS_CHANNEL_ID: undefined },
      { DISCORD_BOT_TOKEN: undefined, DISCORD_ENABLED: false },
    ]) {
      const deps = createDeps({ config, notify });
      const result = await runDeadlineAlerts(deps, NOW);
      expect(result).toEqual({
        enabled: false,
        due: 0,
        alerted: 0,
        skipped: 0,
        calendar: DISABLED_CALENDAR,
      });
    }
    expect(notify.postChannelMessage).not.toHaveBeenCalled();
  });

  it('is disabled without a notifier even when the channel id is set', async () => {
    const deps = createDeps({ notify: undefined });
    const result = await runDeadlineAlerts(deps, NOW);
    expect(result).toEqual({
      enabled: false,
      due: 0,
      alerted: 0,
      skipped: 0,
      calendar: DISABLED_CALENDAR,
    });
  });

  it('alerts tasks due today in ET, with due_date taking precedence over jobs.deadline', async () => {
    const writes: DbWrite[] = [];
    const rows = [
      // Due via the posting deadline (2026-07-19T00:00Z = ET July 18).
      row({ taskId: 'aaaaaaaa-0000-4000-8000-00000000000a' }),
      // The user's OWN due date wins: it reads ET July 17, so the task is
      // NOT due — even though the posting deadline alone would be.
      row({
        taskId: 'aaaaaaaa-0000-4000-8000-00000000000b',
        dueDate: new Date('2026-07-18T00:00:00Z'),
        deadline: new Date('2026-07-19T00:00:00Z'),
      }),
      // Due via the user's due date; the (non-due) posting deadline is moot.
      row({
        taskId: 'aaaaaaaa-0000-4000-8000-00000000000c',
        dueDate: new Date('2026-07-19T00:00:00Z'),
        deadline: new Date('2026-08-01T00:00:00Z'),
      }),
      // Not due at all: deadline reads ET July 17.
      row({
        taskId: 'aaaaaaaa-0000-4000-8000-00000000000d',
        deadline: new Date('2026-07-18T00:00:00Z'),
      }),
    ];
    const db = createFakeDb({ selectResults: [rows, []], writes });
    const notify = createNotify();
    const deps = createDeps({ db, notify });

    const result = await runDeadlineAlerts(deps, NOW);

    expect(result).toEqual({
      enabled: true,
      due: 2,
      alerted: 2,
      skipped: 0,
      calendar: DISABLED_CALENDAR,
    });
    expect(notify.postChannelMessage).toHaveBeenCalledTimes(2);
    expect(vi.mocked(notify.postChannelMessage).mock.calls[0]?.[0]).toBe(
      'chan-alerts',
    );

    const alertEvents = writes
      .filter((w) => w.method === 'insert' && w.table === events)
      .map((w) => w.arg as Record<string, unknown>);
    expect(alertEvents).toHaveLength(2);
    expect(alertEvents[0]).toEqual({
      taskId: 'aaaaaaaa-0000-4000-8000-00000000000a',
      type: DEADLINE_ALERT_EVENT,
      data: { date: TODAY_ET, channel: 'discord' },
    });
    expect(alertEvents[1]?.taskId).toBe('aaaaaaaa-0000-4000-8000-00000000000c');
  });

  it("a date-only dueDate ('2026-07-20') alerts on ET July 20's run, NOT July 19's", async () => {
    // End-to-end with the real normalizer: the meta endpoint stores a
    // date-only dueDate via deadlineFromIsoDate, which now pins it to
    // AMERICA/NEW_YORK midnight of that day (2026-07-20T04:00Z under EDT) —
    // so the alert fires on the ET calendar day the user meant, not the
    // evening before (the old UTC-midnight off-by-one).
    const iso = deadlineFromIsoDate('2026-07-20');
    expect(iso).toBe('2026-07-20T04:00:00.000Z');
    const dueRow = row({
      taskId: 'aaaaaaaa-0000-4000-8000-000000000e01',
      dueDate: new Date(iso ?? ''),
      deadline: null,
    });

    // ET July 19's midnight run (00:30 ET): nothing is due.
    const notifyJul19 = createNotify();
    const resultJul19 = await runDeadlineAlerts(
      createDeps({
        db: createFakeDb({ selectResults: [[dueRow], []] }),
        notify: notifyJul19,
      }),
      new Date('2026-07-19T04:30:00Z'),
    );
    expect(resultJul19).toEqual({
      enabled: true,
      due: 0,
      alerted: 0,
      skipped: 0,
      calendar: DISABLED_CALENDAR,
    });
    expect(notifyJul19.postChannelMessage).not.toHaveBeenCalled();

    // ET July 20's midnight run: the task is due today and alerts.
    const writes: DbWrite[] = [];
    const notifyJul20 = createNotify();
    const resultJul20 = await runDeadlineAlerts(
      createDeps({
        db: createFakeDb({ selectResults: [[dueRow], []], writes }),
        notify: notifyJul20,
      }),
      new Date('2026-07-20T04:30:00Z'),
    );
    expect(resultJul20).toEqual({
      enabled: true,
      due: 1,
      alerted: 1,
      skipped: 0,
      calendar: DISABLED_CALENDAR,
    });
    expect(notifyJul20.postChannelMessage).toHaveBeenCalledTimes(1);
    const inserted = writes
      .filter((w) => w.method === 'insert' && w.table === events)
      .map((w) => w.arg as Record<string, unknown>);
    expect(inserted[0]?.data).toEqual({
      date: '2026-07-20',
      channel: 'discord',
    });
  });

  it('never alerts excluded states (SUBMITTED/CONFIRMED/DISCARDED/DUPLICATE)', async () => {
    const rows = ['SUBMITTED', 'CONFIRMED', 'DISCARDED', 'DUPLICATE'].map(
      (state, i) =>
        row({ taskId: `aaaaaaaa-0000-4000-8000-00000000010${i}`, state }),
    );
    const db = createFakeDb({ selectResults: [rows, []] });
    const notify = createNotify();
    const deps = createDeps({ db, notify });

    const result = await runDeadlineAlerts(deps, NOW);

    expect(result).toEqual({
      enabled: true,
      due: 0,
      alerted: 0,
      skipped: 0,
      calendar: DISABLED_CALENDAR,
    });
    expect(notify.postChannelMessage).not.toHaveBeenCalled();
  });

  it("dedupes on a DEADLINE_ALERT event carrying TODAY's ET date (an older date does not dedupe)", async () => {
    const writes: DbWrite[] = [];
    const rows = [
      row({ taskId: 'aaaaaaaa-0000-4000-8000-000000000201' }),
      row({ taskId: 'aaaaaaaa-0000-4000-8000-000000000202' }),
    ];
    const alertEvents = [
      // Already alerted TODAY → skipped.
      {
        taskId: 'aaaaaaaa-0000-4000-8000-000000000201',
        data: { date: TODAY_ET, channel: 'discord' },
      },
      // Alerted on an EARLIER date (a prior deadline change) → alerts again.
      {
        taskId: 'aaaaaaaa-0000-4000-8000-000000000202',
        data: { date: '2026-07-01', channel: 'discord' },
      },
    ];
    const db = createFakeDb({ selectResults: [rows, alertEvents], writes });
    const notify = createNotify();
    const deps = createDeps({ db, notify });

    const result = await runDeadlineAlerts(deps, NOW);

    expect(result).toEqual({
      enabled: true,
      due: 2,
      alerted: 1,
      skipped: 1,
      calendar: DISABLED_CALENDAR,
    });
    expect(notify.postChannelMessage).toHaveBeenCalledTimes(1);
    const inserted = writes
      .filter((w) => w.method === 'insert' && w.table === events)
      .map((w) => w.arg as Record<string, unknown>);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]?.taskId).toBe('aaaaaaaa-0000-4000-8000-000000000202');
  });

  it('formats the alert: mention, bold Company — Role label, status phrase, dashboard + posting links', async () => {
    const db = createFakeDb({
      selectResults: [
        [row({ taskId: 'aaaaaaaa-0000-4000-8000-000000000301' })],
        [],
      ],
    });
    const notify = createNotify();
    const deps = createDeps({ db, notify });

    await runDeadlineAlerts(deps, NOW);

    const text = vi.mocked(notify.postChannelMessage).mock.calls[0]?.[1];
    expect(text).toBe(
      '<@424242> ⏰ Due today: **Acme — SWE Intern** — needs your answers · ' +
        '[open in sower](https://dash.example/tasks/aaaaaaaa-0000-4000-8000-000000000301) · ' +
        '[posting](https://job.example/x)',
    );
  });

  it('omits the mention and the dashboard link gracefully when unconfigured, and falls back to the shortened URL label', async () => {
    const db = createFakeDb({
      selectResults: [
        [
          row({
            company: null,
            title: null,
            url: 'https://www.weirdats.example/careers/roles/42',
          }),
        ],
        [],
      ],
    });
    const notify = createNotify();
    const deps = createDeps({
      db,
      notify,
      config: {
        DISCORD_ALERT_MENTION_USER_ID: undefined,
        DASHBOARD_BASE_URL: undefined,
      },
    });

    await runDeadlineAlerts(deps, NOW);

    const text = vi.mocked(notify.postChannelMessage).mock.calls[0]?.[1];
    expect(text).toBe(
      '⏰ Due today: **weirdats.example/careers/roles/42** — needs your answers · ' +
        '[posting](https://www.weirdats.example/careers/roles/42)',
    );
    expect(text).not.toContain('<@');
    expect(text).not.toContain('open in sower');
  });

  it('escapes markdown-breaking label characters and stays under 2000 chars', async () => {
    const db = createFakeDb({
      selectResults: [
        [
          row({
            company: 'Acme [Labs]',
            title: `${'x'.repeat(2500)}*bold*`,
          }),
        ],
        [],
      ],
    });
    const notify = createNotify();
    const deps = createDeps({ db, notify });

    await runDeadlineAlerts(deps, NOW);

    const text = vi.mocked(notify.postChannelMessage).mock.calls[0]?.[1] ?? '';
    expect(text).toContain('Acme \\[Labs\\]');
    expect(text.length).toBeLessThanOrEqual(2000);
  });

  it('is per-task tolerant: one failed send is skipped (no event) and the batch continues', async () => {
    const writes: DbWrite[] = [];
    const rows = [
      row({ taskId: 'aaaaaaaa-0000-4000-8000-000000000401' }),
      row({ taskId: 'aaaaaaaa-0000-4000-8000-000000000402' }),
    ];
    const db = createFakeDb({ selectResults: [rows, []], writes });
    const notify = createNotify();
    vi.mocked(notify.postChannelMessage)
      .mockRejectedValueOnce(new Error('discord 500'))
      .mockResolvedValueOnce({ id: 'msg-2' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const deps = createDeps({ db, notify });

    const result = await runDeadlineAlerts(deps, NOW);

    expect(result).toEqual({
      enabled: true,
      due: 2,
      alerted: 1,
      skipped: 1,
      calendar: DISABLED_CALENDAR,
    });
    // Only the successful send recorded its DEADLINE_ALERT event — the
    // failed one stays unrecorded, so the next run retries it.
    const inserted = writes
      .filter((w) => w.method === 'insert' && w.table === events)
      .map((w) => w.arg as Record<string, unknown>);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]?.taskId).toBe('aaaaaaaa-0000-4000-8000-000000000402');
    warn.mockRestore();
  });

  it('runs the calendar reconcile sweep on the same clock and reports its result (proven in calendar-sync.test.ts, mocked here)', async () => {
    calendarState.result = { enabled: true, candidates: 3, synced: 2 };
    const db = createFakeDb({ selectResults: [[], []] });
    const deps = createDeps({ db, notify: createNotify() });

    const result = await runDeadlineAlerts(deps, NOW);

    expect(calendarState.calls).toEqual([NOW]);
    expect(result).toEqual({
      enabled: true,
      due: 0,
      alerted: 0,
      skipped: 0,
      calendar: { enabled: true, candidates: 3, synced: 2 },
    });
  });

  it('runs the reconcile sweep even when Discord alerts are unconfigured (each half self-gates)', async () => {
    calendarState.result = { enabled: true, candidates: 1, synced: 1 };
    const deps = createDeps({
      config: { DISCORD_ALERTS_CHANNEL_ID: undefined },
      notify: undefined,
    });

    const result = await runDeadlineAlerts(deps, NOW);

    expect(calendarState.calls).toEqual([NOW]);
    expect(result.calendar).toEqual({
      enabled: true,
      candidates: 1,
      synced: 1,
    });
    expect(result.enabled).toBe(false);
  });
});

describe('sendDeadlineAlert', () => {
  it('throws (never silently no-ops) when the transport is unconfigured', async () => {
    const deps = createDeps({
      config: { DISCORD_ALERTS_CHANNEL_ID: undefined },
    });
    await expect(
      sendDeadlineAlert(deps, {
        taskId: 't1',
        state: 'NEEDS_INPUT',
        company: 'Acme',
        title: 'SWE Intern',
        url: 'https://job.example/x',
        deadline: new Date('2026-07-19T00:00:00Z'),
      }),
    ).rejects.toThrow(/not configured/);
  });

  it('posts one message to the alerts channel (the single transport seam)', async () => {
    const notify = createNotify();
    const deps = createDeps({ notify });
    await sendDeadlineAlert(deps, {
      taskId: 't1',
      state: 'REVIEW',
      company: 'Acme',
      title: 'SWE Intern',
      url: 'https://job.example/x',
      deadline: new Date('2026-07-19T00:00:00Z'),
    });
    expect(notify.postChannelMessage).toHaveBeenCalledTimes(1);
    const [channel, text] = vi.mocked(notify.postChannelMessage).mock
      .calls[0] ?? ['', ''];
    expect(channel).toBe('chan-alerts');
    expect(text).toContain('ready for your review');
  });
});
