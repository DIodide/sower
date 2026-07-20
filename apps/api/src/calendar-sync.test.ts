import { applicationTasks } from '@sower/db';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildCalendarEvent,
  CALENDAR_ATTENDEE_EMAIL,
  calendarEventTimes,
  isEasternMidnight,
  RECONCILE_MAX_PER_RUN,
  reconcileCalendarEvents,
  resetCalendarTokenCache,
  syncCalendarEventsForJob,
  syncTaskCalendarEvent,
} from './calendar-sync.js';
import type { Config } from './config.js';
import type { Deps } from './types.js';

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
): Deps['db'] & { selectCount: () => number } {
  const selectResults = [...(options.selectResults ?? [])];
  let selects = 0;
  const db = {
    select: () => {
      selects += 1;
      return chain(selectResults.shift() ?? []);
    },
    insert: (table: unknown) =>
      chain([], (arg) =>
        options.writes?.push({ method: 'insert', table, arg }),
      ),
    update: (table: unknown) =>
      chain([], (arg) =>
        options.writes?.push({ method: 'update', table, arg }),
      ),
    selectCount: () => selects,
  };
  return db as unknown as Deps['db'] & { selectCount: () => number };
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
  DASHBOARD_BASE_URL: 'https://dash.example',
  GMAIL_CLIENT_ID: 'client-id',
  GMAIL_CLIENT_SECRET: 'client-secret',
  GOOGLE_CALENDAR_REFRESH_TOKEN: 'refresh-token',
  CALENDAR_SYNC_ENABLED: true,
};

function createDeps(overrides: {
  config?: Partial<Config>;
  db?: Deps['db'];
}): Deps {
  return {
    db: overrides.db ?? createFakeDb(),
    queue: { enqueueProcess: vi.fn(async () => {}) },
    config: { ...baseConfig, ...overrides.config },
    logger: false,
  };
}

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const EVENTS_URL =
  'https://www.googleapis.com/calendar/v3/calendars/primary/events';

function respond(status: number, body: unknown = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

/** One recorded Calendar API call (token requests are filtered out). */
interface ApiCall {
  method: string;
  url: string;
  body: unknown;
}

/**
 * Fake fetch: serves the OAuth token endpoint automatically, records every
 * Calendar call, and answers each from the provided queue (in order).
 */
function createFetch(responses: Response[] = []) {
  const queue = [...responses];
  const calls: ApiCall[] = [];
  const fetchImpl = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === TOKEN_URL) {
        return respond(200, { access_token: 'tok-1', expires_in: 3600 });
      }
      calls.push({
        method: init?.method ?? 'GET',
        url,
        body:
          typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      });
      const next = queue.shift();
      if (!next) {
        throw new Error(`unexpected fetch ${init?.method ?? 'GET'} ${url}`);
      }
      return next;
    },
  ) as unknown as typeof fetch & { mock: { calls: unknown[][] } };
  return { fetchImpl, calls };
}

function tokenCalls(fetchImpl: { mock: { calls: unknown[][] } }): number {
  return fetchImpl.mock.calls.filter((call) => String(call[0]) === TOKEN_URL)
    .length;
}

const TASK_ID = 'aaaaaaaa-0000-4000-8000-000000000001';

/** A task+job join row as the sync select returns it. */
function row(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    taskId: TASK_ID,
    state: 'NEEDS_INPUT',
    // Date-only due date as deadlineFromIsoDate stores it: ET midnight.
    dueDate: new Date('2026-07-20T04:00:00Z'),
    calendarEventId: null,
    company: 'Acme',
    title: 'SWE Intern',
    url: 'https://job.example/x',
    deadline: null,
    ...overrides,
  };
}

beforeEach(() => {
  resetCalendarTokenCache();
});

describe('isEasternMidnight', () => {
  it('detects ET midnight under EDT (summer, 04:00Z)', () => {
    expect(isEasternMidnight(new Date('2026-07-20T04:00:00Z'))).toBe(true);
    expect(isEasternMidnight(new Date('2026-07-20T05:00:00Z'))).toBe(false);
    // UTC midnight is the previous ET EVENING in summer — a timed instant.
    expect(isEasternMidnight(new Date('2026-07-20T00:00:00Z'))).toBe(false);
  });

  it('detects ET midnight under EST (winter, 05:00Z)', () => {
    expect(isEasternMidnight(new Date('2026-01-10T05:00:00Z'))).toBe(true);
    expect(isEasternMidnight(new Date('2026-01-10T04:00:00Z'))).toBe(false);
  });
});

describe('calendarEventTimes', () => {
  it('renders an ET-midnight instant as an all-day event on that ET date', () => {
    expect(calendarEventTimes(new Date('2026-07-20T04:00:00Z'))).toEqual({
      start: { date: '2026-07-20' },
      end: { date: '2026-07-21' },
    });
    // Winter (EST) and a month-end rollover.
    expect(calendarEventTimes(new Date('2026-01-31T05:00:00Z'))).toEqual({
      start: { date: '2026-01-31' },
      end: { date: '2026-02-01' },
    });
  });

  it('renders a timed instant as a one-hour block ENDING at the deadline', () => {
    expect(calendarEventTimes(new Date('2026-08-01T21:00:00Z'))).toEqual({
      start: {
        dateTime: '2026-08-01T20:00:00.000Z',
        timeZone: 'America/New_York',
      },
      end: {
        dateTime: '2026-08-01T21:00:00.000Z',
        timeZone: 'America/New_York',
      },
    });
  });

  it('treats a legacy UTC-midnight deadline as TIMED (8 PM ET the evening before)', () => {
    // extractDeadline/legacy rows store UTC midnight, which is 20:00 ET the
    // previous day — a real instant, not a date, so it stays a timed block.
    expect(calendarEventTimes(new Date('2026-07-19T00:00:00Z'))).toEqual({
      start: {
        dateTime: '2026-07-18T23:00:00.000Z',
        timeZone: 'America/New_York',
      },
      end: {
        dateTime: '2026-07-19T00:00:00.000Z',
        timeZone: 'America/New_York',
      },
    });
  });
});

describe('buildCalendarEvent', () => {
  it('builds summary, description links, the attendee, and default reminders', () => {
    const event = buildCalendarEvent(
      row() as Parameters<typeof buildCalendarEvent>[0],
      new Date('2026-07-20T04:00:00Z'),
      baseConfig,
    );
    expect(event).toEqual({
      summary: '⏰ Acme — SWE Intern application due',
      description:
        `Task: https://dash.example/tasks/${TASK_ID}\n` +
        'Posting: https://job.example/x',
      start: { date: '2026-07-20' },
      end: { date: '2026-07-21' },
      attendees: [{ email: 'ibraheem@princeton.edu' }],
      reminders: { useDefault: true },
    });
    expect(CALENDAR_ATTENDEE_EMAIL).toBe('ibraheem@princeton.edu');
  });

  it('falls back to the shortened URL label and degrades links gracefully', () => {
    const event = buildCalendarEvent(
      row({
        company: null,
        title: null,
        url: 'manual://screenshot',
      }) as Parameters<typeof buildCalendarEvent>[0],
      new Date('2026-07-20T04:00:00Z'),
      { ...baseConfig, DASHBOARD_BASE_URL: undefined },
    );
    expect(event.summary).toBe('⏰ manual://screenshot application due');
    // No dashboard base + a non-http url: no dangling link lines.
    expect(event.description).toBe('');
  });
});

describe('syncTaskCalendarEvent', () => {
  it('no-ops {kind:disabled} before touching the db or the network', async () => {
    const db = createFakeDb();
    const { fetchImpl } = createFetch();
    const deps = createDeps({ db, config: { CALENDAR_SYNC_ENABLED: false } });

    const outcome = await syncTaskCalendarEvent(deps, TASK_ID, fetchImpl);

    expect(outcome).toEqual({ kind: 'disabled' });
    expect(db.selectCount()).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns not_found for a deleted task', async () => {
    const { fetchImpl } = createFetch();
    const deps = createDeps({ db: createFakeDb({ selectResults: [[]] }) });
    const outcome = await syncTaskCalendarEvent(deps, TASK_ID, fetchImpl);
    expect(outcome).toEqual({ kind: 'not_found' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('INSERTS an all-day event (with sendUpdates=all) and stores the id', async () => {
    const writes: DbWrite[] = [];
    const db = createFakeDb({ selectResults: [[row()]], writes });
    const { fetchImpl, calls } = createFetch([respond(200, { id: 'evt-1' })]);
    const deps = createDeps({ db });

    const outcome = await syncTaskCalendarEvent(deps, TASK_ID, fetchImpl);

    expect(outcome).toEqual({ kind: 'created', eventId: 'evt-1' });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.url).toBe(`${EVENTS_URL}?sendUpdates=all`);
    expect(calls[0]?.body).toMatchObject({
      summary: '⏰ Acme — SWE Intern application due',
      start: { date: '2026-07-20' },
      end: { date: '2026-07-21' },
      attendees: [{ email: 'ibraheem@princeton.edu' }],
      reminders: { useDefault: true },
    });
    expect(writes).toEqual([
      {
        method: 'update',
        table: applicationTasks,
        arg: { calendarEventId: 'evt-1' },
      },
    ]);
  });

  it('inserts a TIMED event for a deadline instant carrying a real time', async () => {
    const db = createFakeDb({
      selectResults: [
        [row({ dueDate: null, deadline: new Date('2026-08-01T21:00:00Z') })],
      ],
      writes: [],
    });
    const { fetchImpl, calls } = createFetch([respond(200, { id: 'evt-2' })]);

    const outcome = await syncTaskCalendarEvent(
      createDeps({ db }),
      TASK_ID,
      fetchImpl,
    );

    expect(outcome).toEqual({ kind: 'created', eventId: 'evt-2' });
    expect(calls[0]?.body).toMatchObject({
      start: {
        dateTime: '2026-08-01T20:00:00.000Z',
        timeZone: 'America/New_York',
      },
      end: {
        dateTime: '2026-08-01T21:00:00.000Z',
        timeZone: 'America/New_York',
      },
    });
  });

  it("the user's dueDate WINS over the posting deadline", async () => {
    const db = createFakeDb({
      selectResults: [
        [
          row({
            dueDate: new Date('2026-07-20T04:00:00Z'),
            deadline: new Date('2026-09-01T04:00:00Z'),
          }),
        ],
      ],
    });
    const { fetchImpl, calls } = createFetch([respond(200, { id: 'evt-3' })]);

    await syncTaskCalendarEvent(createDeps({ db }), TASK_ID, fetchImpl);

    expect(calls[0]?.body).toMatchObject({ start: { date: '2026-07-20' } });
  });

  it('PATCHES the stored event on a later sync (no id rewrite)', async () => {
    const writes: DbWrite[] = [];
    const db = createFakeDb({
      selectResults: [[row({ calendarEventId: 'evt-9' })]],
      writes,
    });
    const { fetchImpl, calls } = createFetch([respond(200, { id: 'evt-9' })]);

    const outcome = await syncTaskCalendarEvent(
      createDeps({ db }),
      TASK_ID,
      fetchImpl,
    );

    expect(outcome).toEqual({ kind: 'updated', eventId: 'evt-9' });
    expect(calls).toEqual([
      {
        method: 'PATCH',
        url: `${EVENTS_URL}/evt-9?sendUpdates=all`,
        body: expect.objectContaining({ start: { date: '2026-07-20' } }),
      },
    ]);
    expect(writes).toEqual([]);
  });

  it('RECREATES the event when the PATCH 404s (user deleted it)', async () => {
    const writes: DbWrite[] = [];
    const db = createFakeDb({
      selectResults: [[row({ calendarEventId: 'evt-9' })]],
      writes,
    });
    const { fetchImpl, calls } = createFetch([
      respond(404),
      respond(200, { id: 'evt-new' }),
    ]);

    const outcome = await syncTaskCalendarEvent(
      createDeps({ db }),
      TASK_ID,
      fetchImpl,
    );

    expect(outcome).toEqual({ kind: 'recreated', eventId: 'evt-new' });
    expect(calls.map((c) => c.method)).toEqual(['PATCH', 'POST']);
    expect(writes).toEqual([
      {
        method: 'update',
        table: applicationTasks,
        arg: { calendarEventId: 'evt-new' },
      },
    ]);
  });

  it('DELETES the event and nulls the column when the task is discarded', async () => {
    const writes: DbWrite[] = [];
    const db = createFakeDb({
      selectResults: [[row({ state: 'DISCARDED', calendarEventId: 'evt-9' })]],
      writes,
    });
    const { fetchImpl, calls } = createFetch([respond(204)]);

    const outcome = await syncTaskCalendarEvent(
      createDeps({ db }),
      TASK_ID,
      fetchImpl,
    );

    expect(outcome).toEqual({ kind: 'deleted' });
    expect(calls).toEqual([
      {
        method: 'DELETE',
        url: `${EVENTS_URL}/evt-9?sendUpdates=all`,
        body: undefined,
      },
    ]);
    expect(writes).toEqual([
      {
        method: 'update',
        table: applicationTasks,
        arg: { calendarEventId: null },
      },
    ]);
  });

  it('deletes when the effective deadline was CLEARED, tolerating an already-gone event', async () => {
    const writes: DbWrite[] = [];
    const db = createFakeDb({
      selectResults: [
        [row({ dueDate: null, deadline: null, calendarEventId: 'evt-9' })],
      ],
      writes,
    });
    const { fetchImpl } = createFetch([respond(404)]);

    const outcome = await syncTaskCalendarEvent(
      createDeps({ db }),
      TASK_ID,
      fetchImpl,
    );

    // 404 on delete = the user already removed it — still a success.
    expect(outcome).toEqual({ kind: 'deleted' });
    expect(writes).toEqual([
      {
        method: 'update',
        table: applicationTasks,
        arg: { calendarEventId: null },
      },
    ]);
  });

  it('no-ops when no event is desired and none is stored (zero fetches)', async () => {
    const db = createFakeDb({
      selectResults: [[row({ dueDate: null, deadline: null })]],
    });
    const { fetchImpl } = createFetch();

    const outcome = await syncTaskCalendarEvent(
      createDeps({ db }),
      TASK_ID,
      fetchImpl,
    );

    expect(outcome).toEqual({ kind: 'noop' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('never throws: a network failure is logged and reported as {kind:error}', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const db = createFakeDb({ selectResults: [[row()]] });
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNRESET');
    }) as unknown as typeof fetch;

    const outcome = await syncTaskCalendarEvent(
      createDeps({ db }),
      TASK_ID,
      fetchImpl,
    );

    expect(outcome).toEqual({ kind: 'error', error: 'ECONNRESET' });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('caches the access token per process (one mint across two syncs)', async () => {
    const db = createFakeDb({ selectResults: [[row()], [row()]] });
    const { fetchImpl } = createFetch([
      respond(200, { id: 'evt-1' }),
      respond(200, { id: 'evt-1' }),
    ]);
    const deps = createDeps({ db });

    await syncTaskCalendarEvent(deps, TASK_ID, fetchImpl);
    await syncTaskCalendarEvent(deps, TASK_ID, fetchImpl);

    expect(tokenCalls(fetchImpl as never)).toBe(1);
  });
});

describe('syncCalendarEventsForJob', () => {
  it('no-ops while disabled (no db access)', async () => {
    const db = createFakeDb();
    const { fetchImpl } = createFetch();
    await syncCalendarEventsForJob(
      createDeps({ db, config: { CALENDAR_SYNC_ENABLED: false } }),
      'job-1',
      fetchImpl,
    );
    expect(db.selectCount()).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('syncs every task on the job', async () => {
    const writes: DbWrite[] = [];
    const taskB = 'aaaaaaaa-0000-4000-8000-000000000002';
    const db = createFakeDb({
      selectResults: [
        [{ taskId: TASK_ID }, { taskId: taskB }],
        [row()],
        [row({ taskId: taskB, calendarEventId: 'evt-b' })],
      ],
      writes,
    });
    const { fetchImpl, calls } = createFetch([
      respond(200, { id: 'evt-a' }),
      respond(200, { id: 'evt-b' }),
    ]);

    await syncCalendarEventsForJob(createDeps({ db }), 'job-1', fetchImpl);

    // Task A had no event (insert); task B had one (patch).
    expect(calls.map((c) => c.method)).toEqual(['POST', 'PATCH']);
    expect(writes).toEqual([
      {
        method: 'update',
        table: applicationTasks,
        arg: { calendarEventId: 'evt-a' },
      },
    ]);
  });
});

describe('reconcileCalendarEvents', () => {
  /** Noon ET July 18, 2026 — the sweep's injected clock. */
  const NOW = new Date('2026-07-18T16:00:00Z');

  it('reports {enabled:false} without touching the db while disabled', async () => {
    const db = createFakeDb();
    const { fetchImpl } = createFetch();
    const result = await reconcileCalendarEvents(
      createDeps({ db, config: { CALENDAR_SYNC_ENABLED: false } }),
      NOW,
      fetchImpl,
    );
    expect(result).toEqual({ enabled: false, candidates: 0, synced: 0 });
    expect(db.selectCount()).toBe(0);
  });

  it('backfills missing events, deletes stale ones, and skips past/consistent rows', async () => {
    const writes: DbWrite[] = [];
    const missing = row(); // future dueDate, no event, active → insert
    const stale = {
      // Future deadline but SUBMITTED with a lingering event → delete.
      taskId: 'aaaaaaaa-0000-4000-8000-000000000002',
      state: 'SUBMITTED',
      dueDate: null,
      calendarEventId: 'evt-stale',
      deadline: new Date('2026-07-25T04:00:00Z'),
    };
    const past = {
      // Past deadline: history, never touched (even without an event).
      taskId: 'aaaaaaaa-0000-4000-8000-000000000003',
      state: 'NEEDS_INPUT',
      dueDate: new Date('2026-07-01T04:00:00Z'),
      calendarEventId: null,
      deadline: null,
    };
    const consistent = {
      // Future deadline, active, event present: nothing to heal.
      taskId: 'aaaaaaaa-0000-4000-8000-000000000004',
      state: 'REVIEW',
      dueDate: new Date('2026-07-22T04:00:00Z'),
      calendarEventId: 'evt-ok',
      deadline: null,
    };
    const db = createFakeDb({
      selectResults: [
        [missing, stale, past, consistent],
        // Per-mismatch syncs re-load their task+job row.
        [missing],
        [
          row({
            taskId: stale.taskId,
            state: 'SUBMITTED',
            dueDate: null,
            calendarEventId: 'evt-stale',
            deadline: stale.deadline,
          }),
        ],
      ],
      writes,
    });
    const { fetchImpl, calls } = createFetch([
      respond(200, { id: 'evt-new' }),
      respond(204),
    ]);

    const result = await reconcileCalendarEvents(
      createDeps({ db }),
      NOW,
      fetchImpl,
    );

    expect(result).toEqual({ enabled: true, candidates: 2, synced: 2 });
    expect(calls.map((c) => [c.method, c.url])).toEqual([
      ['POST', `${EVENTS_URL}?sendUpdates=all`],
      ['DELETE', `${EVENTS_URL}/evt-stale?sendUpdates=all`],
    ]);
    expect(writes).toEqual([
      {
        method: 'update',
        table: applicationTasks,
        arg: { calendarEventId: 'evt-new' },
      },
      {
        method: 'update',
        table: applicationTasks,
        arg: { calendarEventId: null },
      },
    ]);
  });

  it('a deadline due TODAY (ET) still reconciles — today-or-future, not future-only', async () => {
    const dueToday = row({ dueDate: new Date('2026-07-18T04:00:00Z') });
    const db = createFakeDb({
      selectResults: [[dueToday], [dueToday]],
      writes: [],
    });
    const { fetchImpl, calls } = createFetch([respond(200, { id: 'evt-1' })]);

    const result = await reconcileCalendarEvents(
      createDeps({ db }),
      NOW,
      fetchImpl,
    );

    expect(result).toEqual({ enabled: true, candidates: 1, synced: 1 });
    expect(calls[0]?.method).toBe('POST');
  });

  it(`caps at ${RECONCILE_MAX_PER_RUN} syncs per run and reports the full candidate count`, async () => {
    const total = RECONCILE_MAX_PER_RUN + 5;
    const rows = Array.from({ length: total }, (_, i) =>
      row({ taskId: `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, '0')}` }),
    );
    const db = createFakeDb({
      // The join select, then one task re-load per capped sync.
      selectResults: [
        rows,
        ...rows.slice(0, RECONCILE_MAX_PER_RUN).map((r) => [r]),
      ],
    });
    const { fetchImpl, calls } = createFetch(
      Array.from({ length: RECONCILE_MAX_PER_RUN }, (_, i) =>
        respond(200, { id: `evt-${i}` }),
      ),
    );

    const result = await reconcileCalendarEvents(
      createDeps({ db }),
      NOW,
      fetchImpl,
    );

    expect(result).toEqual({
      enabled: true,
      candidates: total,
      synced: RECONCILE_MAX_PER_RUN,
    });
    expect(calls).toHaveLength(RECONCILE_MAX_PER_RUN);
  });

  it('never throws: a broken sweep query is logged and reported as zero work', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const db = {
      select: () => {
        throw new Error('db down');
      },
    } as unknown as Deps['db'];
    const { fetchImpl } = createFetch();

    const result = await reconcileCalendarEvents(
      createDeps({ db }),
      NOW,
      fetchImpl,
    );

    expect(result).toEqual({ enabled: true, candidates: 0, synced: 0 });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
