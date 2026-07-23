import { events, followups } from '@sower/db';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from './config.js';
import { buildServer } from './server.js';
import type { Deps } from './types.js';

/**
 * /followups routes against a fake db: create (parent 404, RECEIVED +
 * source manual, FOLLOWUP_CREATED event, ET-midnight dueDate, calendar
 * sync), detail join shape, PATCH field semantics + FOLLOWUP_UPDATED, the
 * transition endpoint's 409-with-allowed-events contract, and reassignment
 * (both timelines annotated, conditional re-sync). The calendar sync
 * itself is proven in calendar-sync.test.ts and mocked here.
 */

const calendarState = vi.hoisted(() => ({
  calls: [] as string[],
  result: { kind: 'noop' } as
    | { kind: 'noop' | 'disabled' | 'deleted' }
    | { kind: 'created' | 'updated' | 'recreated'; eventId: string },
}));

vi.mock('./calendar-sync.js', () => ({
  syncFollowupCalendarEvent: vi.fn(
    async (_deps: unknown, followupId: string) => {
      calendarState.calls.push(followupId);
      return calendarState.result;
    },
  ),
  syncTaskCalendarEvent: vi.fn(async () => ({ kind: 'disabled' })),
  syncCalendarEventsForJob: vi.fn(async () => {}),
  reconcileCalendarEvents: vi.fn(async () => ({
    enabled: false,
    candidates: 0,
    synced: 0,
  })),
}));

interface Chain {
  from: () => Chain;
  where: () => Chain;
  limit: () => Chain;
  innerJoin: () => Chain;
  orderBy: () => Chain;
  values: (arg?: unknown) => Chain;
  set: (arg?: unknown) => Chain;
  returning: () => Chain;
  onConflictDoNothing: () => Chain;
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
    set: (arg?: unknown) => {
      onArg?.(arg);
      return self;
    },
    returning: () => self,
    onConflictDoNothing: () => self,
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
    insert: (table: unknown) =>
      chain(insertResults.shift() ?? [], (arg) =>
        options.writes?.push({ method: 'insert', table, arg }),
      ),
    update: (table: unknown) =>
      chain(updateResults.shift() ?? [], (arg) =>
        options.writes?.push({ method: 'update', table, arg }),
      ),
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
const FOLLOWUP_ID = 'bbbbbbbb-0000-4000-8000-000000000001';
const AUTH = { 'x-api-key': 'test-key' };

/** A followups row as the db returns it. */
function followupRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: FOLLOWUP_ID,
    taskId: TASK_ID,
    kind: 'assessment',
    title: 'Assessment — HackerRank invite',
    state: 'RECEIVED',
    url: null,
    notes: null,
    dueDate: null,
    source: 'manual',
    sourceRef: null,
    sourceBody: null,
    calendarEventId: null,
    createdAt: new Date('2026-07-18T12:00:00Z'),
    updatedAt: new Date('2026-07-18T12:00:00Z'),
    ...overrides,
  };
}

beforeEach(() => {
  calendarState.calls = [];
  calendarState.result = { kind: 'noop' };
});

describe('POST /tasks/:taskId/followups', () => {
  it('requires the api key', async () => {
    const app = buildServer(createDeps(createFakeDb()));
    const response = await app.inject({
      method: 'POST',
      url: `/tasks/${TASK_ID}/followups`,
      payload: { kind: 'assessment', title: 'x' },
    });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it('rejects an unknown kind, an http url, and an over-long title with 400', async () => {
    const app = buildServer(createDeps(createFakeDb()));
    for (const payload of [
      { kind: 'assessmenty', title: 'x' },
      { kind: 'assessment', title: 'x', url: 'http://hackerrank.com/t' },
      { kind: 'assessment', title: 'x'.repeat(301) },
      { kind: 'assessment', title: 'x', dueDate: 'not-a-date' },
    ]) {
      const response = await app.inject({
        method: 'POST',
        url: `/tasks/${TASK_ID}/followups`,
        headers: AUTH,
        payload,
      });
      expect(response.statusCode).toBe(400);
    }
    await app.close();
  });

  it('404s on an unknown task, writing nothing', async () => {
    const writes: DbWrite[] = [];
    const app = buildServer(
      createDeps(createFakeDb({ selectResults: [[]], writes })),
    );
    const response = await app.inject({
      method: 'POST',
      url: `/tasks/${TASK_ID}/followups`,
      headers: AUTH,
      payload: { kind: 'assessment', title: 'x' },
    });
    expect(response.statusCode).toBe(404);
    expect(writes).toHaveLength(0);
    await app.close();
  });

  it('creates a RECEIVED/manual follow-up, records FOLLOWUP_CREATED, and syncs the calendar for a dueDate', async () => {
    const writes: DbWrite[] = [];
    const created = followupRow({
      url: 'https://www.hackerrank.com/tests/abc',
      // Date-only dueDate normalized to ET midnight (EDT: 04:00Z).
      dueDate: new Date('2026-08-04T04:00:00.000Z'),
    });
    calendarState.result = { kind: 'created', eventId: 'evt-9' };
    const db = createFakeDb({
      selectResults: [[{ id: TASK_ID }]],
      insertResults: [[created], []],
      writes,
    });
    const app = buildServer(createDeps(db));
    const response = await app.inject({
      method: 'POST',
      url: `/tasks/${TASK_ID}/followups`,
      headers: AUTH,
      payload: {
        kind: 'assessment',
        title: 'Assessment — HackerRank invite',
        url: 'https://www.hackerrank.com/tests/abc',
        dueDate: '2026-08-04',
      },
    });
    expect(response.statusCode).toBe(200);
    const followupWrite = writes.find(
      (w) => w.method === 'insert' && w.table === followups,
    );
    expect(followupWrite?.arg).toMatchObject({
      taskId: TASK_ID,
      kind: 'assessment',
      title: 'Assessment — HackerRank invite',
      state: 'RECEIVED',
      source: 'manual',
      url: 'https://www.hackerrank.com/tests/abc',
      notes: null,
      dueDate: new Date('2026-08-04T04:00:00.000Z'),
    });
    const eventWrite = writes.find(
      (w) => w.method === 'insert' && w.table === events,
    );
    expect(eventWrite?.arg).toEqual({
      taskId: TASK_ID,
      type: 'FOLLOWUP_CREATED',
      data: {
        followupId: FOLLOWUP_ID,
        kind: 'assessment',
        title: 'Assessment — HackerRank invite',
        source: 'manual',
      },
    });
    expect(calendarState.calls).toEqual([FOLLOWUP_ID]);
    // The just-created calendar event id is reflected in the response.
    const body = response.json() as { followup: { calendarEventId: string } };
    expect(body.followup.calendarEventId).toBe('evt-9');
    await app.close();
  });

  it('skips the calendar sync when no dueDate was given', async () => {
    const db = createFakeDb({
      selectResults: [[{ id: TASK_ID }]],
      insertResults: [[followupRow()], []],
    });
    const app = buildServer(createDeps(db));
    const response = await app.inject({
      method: 'POST',
      url: `/tasks/${TASK_ID}/followups`,
      headers: AUTH,
      payload: { kind: 'recruiter', title: 'Recruiter — intro call' },
    });
    expect(response.statusCode).toBe(200);
    expect(calendarState.calls).toEqual([]);
    await app.close();
  });
});

describe('GET /followups/:id', () => {
  it('404s on an unknown follow-up', async () => {
    const app = buildServer(createDeps(createFakeDb({ selectResults: [[]] })));
    const response = await app.inject({
      method: 'GET',
      url: `/followups/${FOLLOWUP_ID}`,
      headers: AUTH,
    });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it('serves {followup, task:{id, company, title, state}}', async () => {
    const db = createFakeDb({
      selectResults: [
        [
          {
            followup: followupRow(),
            task: {
              id: TASK_ID,
              company: 'Akuna Capital',
              title: 'SWE Intern',
              state: 'SUBMITTED',
            },
          },
        ],
      ],
    });
    const app = buildServer(createDeps(db));
    const response = await app.inject({
      method: 'GET',
      url: `/followups/${FOLLOWUP_ID}`,
      headers: AUTH,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      followup: { id: string; state: string };
      task: Record<string, unknown>;
    };
    expect(body.followup.id).toBe(FOLLOWUP_ID);
    expect(body.task).toEqual({
      id: TASK_ID,
      company: 'Akuna Capital',
      title: 'SWE Intern',
      state: 'SUBMITTED',
    });
    await app.close();
  });
});

describe('PATCH /followups/:id', () => {
  it('rejects an empty body with 400', async () => {
    const app = buildServer(createDeps(createFakeDb()));
    const response = await app.inject({
      method: 'PATCH',
      url: `/followups/${FOLLOWUP_ID}`,
      headers: AUTH,
      payload: {},
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it('404s on an unknown follow-up', async () => {
    const app = buildServer(createDeps(createFakeDb({ selectResults: [[]] })));
    const response = await app.inject({
      method: 'PATCH',
      url: `/followups/${FOLLOWUP_ID}`,
      headers: AUTH,
      payload: { title: 'renamed' },
    });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it('writes only the provided fields, records FOLLOWUP_UPDATED naming them, and skips the sync without a dueDate change', async () => {
    const writes: DbWrite[] = [];
    const db = createFakeDb({
      selectResults: [[followupRow()]],
      updateResults: [[followupRow({ title: 'renamed', notes: 'call notes' })]],
      writes,
    });
    const app = buildServer(createDeps(db));
    const response = await app.inject({
      method: 'PATCH',
      url: `/followups/${FOLLOWUP_ID}`,
      headers: AUTH,
      payload: { title: 'renamed', notes: 'call notes' },
    });
    expect(response.statusCode).toBe(200);
    const update = writes.find((w) => w.method === 'update');
    expect(update?.table).toBe(followups);
    expect(update?.arg).toMatchObject({
      title: 'renamed',
      notes: 'call notes',
    });
    expect(update?.arg).not.toHaveProperty('url');
    expect(update?.arg).not.toHaveProperty('dueDate');
    const eventWrite = writes.find(
      (w) => w.method === 'insert' && w.table === events,
    );
    expect(eventWrite?.arg).toEqual({
      taskId: TASK_ID,
      type: 'FOLLOWUP_UPDATED',
      data: { followupId: FOLLOWUP_ID, fields: ['title', 'notes'] },
    });
    expect(calendarState.calls).toEqual([]);
    await app.close();
  });

  it('normalizes a date-only dueDate to ET midnight and re-syncs the calendar', async () => {
    const writes: DbWrite[] = [];
    calendarState.result = { kind: 'created', eventId: 'evt-1' };
    const db = createFakeDb({
      selectResults: [[followupRow()]],
      updateResults: [
        [followupRow({ dueDate: new Date('2026-08-04T04:00:00.000Z') })],
      ],
      writes,
    });
    const app = buildServer(createDeps(db));
    const response = await app.inject({
      method: 'PATCH',
      url: `/followups/${FOLLOWUP_ID}`,
      headers: AUTH,
      payload: { dueDate: '2026-08-04' },
    });
    expect(response.statusCode).toBe(200);
    const update = writes.find((w) => w.method === 'update');
    expect(update?.arg).toMatchObject({
      dueDate: new Date('2026-08-04T04:00:00.000Z'),
    });
    expect(calendarState.calls).toEqual([FOLLOWUP_ID]);
    const body = response.json() as { followup: { calendarEventId: string } };
    expect(body.followup.calendarEventId).toBe('evt-1');
    await app.close();
  });

  it('clearing the dueDate (null) still re-syncs (the sync deletes the event)', async () => {
    const writes: DbWrite[] = [];
    calendarState.result = { kind: 'deleted' };
    const db = createFakeDb({
      selectResults: [
        [
          followupRow({
            dueDate: new Date('2026-08-04T04:00:00.000Z'),
            calendarEventId: 'evt-1',
          }),
        ],
      ],
      updateResults: [[followupRow({ calendarEventId: 'evt-1' })]],
      writes,
    });
    const app = buildServer(createDeps(db));
    const response = await app.inject({
      method: 'PATCH',
      url: `/followups/${FOLLOWUP_ID}`,
      headers: AUTH,
      payload: { dueDate: null },
    });
    expect(response.statusCode).toBe(200);
    const update = writes.find((w) => w.method === 'update');
    expect(update?.arg).toMatchObject({ dueDate: null });
    expect(calendarState.calls).toEqual([FOLLOWUP_ID]);
    const body = response.json() as {
      followup: { calendarEventId: string | null };
    };
    expect(body.followup.calendarEventId).toBeNull();
    await app.close();
  });
});

describe('POST /followups/:id/transition', () => {
  it('rejects an unknown event name with 400', async () => {
    const app = buildServer(createDeps(createFakeDb()));
    const response = await app.inject({
      method: 'POST',
      url: `/followups/${FOLLOWUP_ID}/transition`,
      headers: AUTH,
      payload: { event: 'NOT_AN_EVENT' },
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it('404s on an unknown follow-up', async () => {
    const app = buildServer(createDeps(createFakeDb({ selectResults: [[]] })));
    const response = await app.inject({
      method: 'POST',
      url: `/followups/${FOLLOWUP_ID}/transition`,
      headers: AUTH,
      payload: { event: 'TRIAGE' },
    });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it('409s a disallowed event, listing the allowed ones, writing nothing', async () => {
    const writes: DbWrite[] = [];
    const db = createFakeDb({
      selectResults: [[followupRow({ state: 'DONE' })]],
      writes,
    });
    const app = buildServer(createDeps(db));
    const response = await app.inject({
      method: 'POST',
      url: `/followups/${FOLLOWUP_ID}/transition`,
      headers: AUTH,
      payload: { event: 'SCHEDULE' },
    });
    expect(response.statusCode).toBe(409);
    const body = response.json() as { error: string; allowed: string[] };
    expect(body.error).toContain('SCHEDULE');
    expect(body.error).toContain('DONE');
    expect(body.allowed).toEqual(['REOPEN']);
    expect(writes).toHaveLength(0);
    expect(calendarState.calls).toEqual([]);
    await app.close();
  });

  it('applies a valid transition, records FOLLOWUP_STATE {from, to}, and syncs the calendar', async () => {
    const writes: DbWrite[] = [];
    const db = createFakeDb({
      selectResults: [[followupRow({ state: 'RECEIVED' })]],
      updateResults: [[followupRow({ state: 'ACTION_NEEDED' })]],
      writes,
    });
    const app = buildServer(createDeps(db));
    const response = await app.inject({
      method: 'POST',
      url: `/followups/${FOLLOWUP_ID}/transition`,
      headers: AUTH,
      payload: { event: 'TRIAGE' },
    });
    expect(response.statusCode).toBe(200);
    const update = writes.find((w) => w.method === 'update');
    expect(update?.table).toBe(followups);
    expect(update?.arg).toMatchObject({ state: 'ACTION_NEEDED' });
    const eventWrite = writes.find(
      (w) => w.method === 'insert' && w.table === events,
    );
    expect(eventWrite?.arg).toEqual({
      taskId: TASK_ID,
      type: 'FOLLOWUP_STATE',
      data: {
        followupId: FOLLOWUP_ID,
        event: 'TRIAGE',
        from: 'RECEIVED',
        to: 'ACTION_NEEDED',
      },
    });
    expect(calendarState.calls).toEqual([FOLLOWUP_ID]);
    const body = response.json() as { followup: { state: string } };
    expect(body.followup.state).toBe('ACTION_NEEDED');
    await app.close();
  });

  it('entering DONE reflects the sync-deleted calendar event in the response', async () => {
    calendarState.result = { kind: 'deleted' };
    const db = createFakeDb({
      selectResults: [
        [
          followupRow({
            state: 'SCHEDULED',
            dueDate: new Date('2026-08-04T04:00:00.000Z'),
            calendarEventId: 'evt-1',
          }),
        ],
      ],
      updateResults: [
        [followupRow({ state: 'DONE', calendarEventId: 'evt-1' })],
      ],
    });
    const app = buildServer(createDeps(db));
    const response = await app.inject({
      method: 'POST',
      url: `/followups/${FOLLOWUP_ID}/transition`,
      headers: AUTH,
      payload: { event: 'RESOLVE' },
    });
    expect(response.statusCode).toBe(200);
    expect(calendarState.calls).toEqual([FOLLOWUP_ID]);
    const body = response.json() as {
      followup: { state: string; calendarEventId: string | null };
    };
    expect(body.followup.state).toBe('DONE');
    expect(body.followup.calendarEventId).toBeNull();
    await app.close();
  });

  it('REOPEN lands in ACTION_NEEDED and re-syncs (recreating the event when a dueDate exists)', async () => {
    calendarState.result = { kind: 'created', eventId: 'evt-2' };
    const db = createFakeDb({
      selectResults: [
        [
          followupRow({
            state: 'DONE',
            dueDate: new Date('2026-08-04T04:00:00.000Z'),
          }),
        ],
      ],
      updateResults: [
        [
          followupRow({
            state: 'ACTION_NEEDED',
            dueDate: new Date('2026-08-04T04:00:00.000Z'),
          }),
        ],
      ],
    });
    const app = buildServer(createDeps(db));
    const response = await app.inject({
      method: 'POST',
      url: `/followups/${FOLLOWUP_ID}/transition`,
      headers: AUTH,
      payload: { event: 'REOPEN' },
    });
    expect(response.statusCode).toBe(200);
    expect(calendarState.calls).toEqual([FOLLOWUP_ID]);
    const body = response.json() as {
      followup: { state: string; calendarEventId: string | null };
    };
    expect(body.followup.state).toBe('ACTION_NEEDED');
    expect(body.followup.calendarEventId).toBe('evt-2');
    await app.close();
  });
});

describe('POST /followups/:id/reassign', () => {
  const TARGET_TASK_ID = 'aaaaaaaa-0000-4000-8000-000000000002';

  it('rejects a non-uuid target with 400', async () => {
    const app = buildServer(createDeps(createFakeDb()));
    const response = await app.inject({
      method: 'POST',
      url: `/followups/${FOLLOWUP_ID}/reassign`,
      headers: AUTH,
      payload: { taskId: 'not-a-uuid' },
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it('404s on an unknown follow-up', async () => {
    const app = buildServer(createDeps(createFakeDb({ selectResults: [[]] })));
    const response = await app.inject({
      method: 'POST',
      url: `/followups/${FOLLOWUP_ID}/reassign`,
      headers: AUTH,
      payload: { taskId: TARGET_TASK_ID },
    });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it('404s on an unknown target task, writing nothing', async () => {
    const writes: DbWrite[] = [];
    const app = buildServer(
      createDeps(
        createFakeDb({ selectResults: [[followupRow()], []], writes }),
      ),
    );
    const response = await app.inject({
      method: 'POST',
      url: `/followups/${FOLLOWUP_ID}/reassign`,
      headers: AUTH,
      payload: { taskId: TARGET_TASK_ID },
    });
    expect(response.statusCode).toBe(404);
    expect((response.json() as { error: string }).error).toBe('task not found');
    expect(writes).toHaveLength(0);
    await app.close();
  });

  it('moves the follow-up, annotates BOTH timelines, and skips the sync with no due date or event', async () => {
    const writes: DbWrite[] = [];
    const db = createFakeDb({
      selectResults: [[followupRow()], [{ id: TARGET_TASK_ID }]],
      updateResults: [[followupRow({ taskId: TARGET_TASK_ID })]],
      writes,
    });
    const app = buildServer(createDeps(db));
    const response = await app.inject({
      method: 'POST',
      url: `/followups/${FOLLOWUP_ID}/reassign`,
      headers: AUTH,
      payload: { taskId: TARGET_TASK_ID },
    });
    expect(response.statusCode).toBe(200);
    const update = writes.find((w) => w.method === 'update');
    expect(update?.table).toBe(followups);
    expect(update?.arg).toMatchObject({ taskId: TARGET_TASK_ID });
    const eventWrites = writes.filter(
      (w) => w.method === 'insert' && w.table === events,
    );
    const data = {
      followupId: FOLLOWUP_ID,
      from: TASK_ID,
      to: TARGET_TASK_ID,
    };
    expect(eventWrites.map((w) => w.arg)).toEqual([
      { taskId: TASK_ID, type: 'FOLLOWUP_REASSIGNED', data },
      { taskId: TARGET_TASK_ID, type: 'FOLLOWUP_REASSIGNED', data },
    ]);
    expect(calendarState.calls).toEqual([]);
    const body = response.json() as { followup: { taskId: string } };
    expect(body.followup.taskId).toBe(TARGET_TASK_ID);
    await app.close();
  });

  it('re-syncs the calendar event when one exists (its summary names the company)', async () => {
    calendarState.result = { kind: 'updated', eventId: 'evt-1' };
    const db = createFakeDb({
      selectResults: [
        [
          followupRow({
            dueDate: new Date('2026-08-04T04:00:00.000Z'),
            calendarEventId: 'evt-1',
          }),
        ],
        [{ id: TARGET_TASK_ID }],
      ],
      updateResults: [
        [
          followupRow({
            taskId: TARGET_TASK_ID,
            dueDate: new Date('2026-08-04T04:00:00.000Z'),
            calendarEventId: 'evt-1',
          }),
        ],
      ],
    });
    const app = buildServer(createDeps(db));
    const response = await app.inject({
      method: 'POST',
      url: `/followups/${FOLLOWUP_ID}/reassign`,
      headers: AUTH,
      payload: { taskId: TARGET_TASK_ID },
    });
    expect(response.statusCode).toBe(200);
    expect(calendarState.calls).toEqual([FOLLOWUP_ID]);
    await app.close();
  });

  it('reassigning to the current task is a clean no-op: no update, no events, no sync', async () => {
    const writes: DbWrite[] = [];
    const db = createFakeDb({
      selectResults: [[followupRow()], [{ id: TASK_ID }]],
      writes,
    });
    const app = buildServer(createDeps(db));
    const response = await app.inject({
      method: 'POST',
      url: `/followups/${FOLLOWUP_ID}/reassign`,
      headers: AUTH,
      payload: { taskId: TASK_ID },
    });
    expect(response.statusCode).toBe(200);
    expect(writes).toHaveLength(0);
    expect(calendarState.calls).toEqual([]);
    await app.close();
  });
});
