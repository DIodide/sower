import { events, followups } from '@sower/db';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from './config.js';
import { parseEmailSourceBody } from './followup-audit.js';
import { buildServer } from './server.js';
import type { Deps } from './types.js';

/**
 * POST /followups/audit against a fake db: the CLAUDE_CODE_OAUTH_TOKEN
 * gate, source_body header re-parsing, and the judge-outcome fan-out —
 * high-confidence noise is DISMISSed through the SHARED transition path
 * (state-guarded update + FOLLOWUP_STATE event carrying the judge's reason
 * + calendar sync), while low-confidence noise, 'followup' verdicts, judge
 * failures, unparseable bodies, and lost races leave rows untouched. The
 * judge itself is proven in followup-judge.test.ts and mocked here; the
 * calendar sync in calendar-sync.test.ts.
 */

const calendarState = vi.hoisted(() => ({ calls: [] as string[] }));

vi.mock('./calendar-sync.js', () => ({
  syncFollowupCalendarEvent: vi.fn(
    async (_deps: unknown, followupId: string) => {
      calendarState.calls.push(followupId);
      return { kind: 'deleted' };
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

const judgeState = vi.hoisted(() => ({
  calls: [] as unknown[],
  results: [] as unknown[],
}));

vi.mock('./followup-judge.js', () => ({
  judgeFollowupMail: vi.fn(async (input: unknown) => {
    judgeState.calls.push(input);
    return judgeState.results.shift() ?? null;
  }),
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
): Deps['db'] & { selectCount: () => number } {
  const selectResults = [...(options.selectResults ?? [])];
  const insertResults = [...(options.insertResults ?? [])];
  const updateResults = [...(options.updateResults ?? [])];
  let selects = 0;
  const db = {
    select: () => {
      selects += 1;
      return chain(selectResults.shift() ?? []);
    },
    insert: (table: unknown) =>
      chain(insertResults.shift() ?? [], (arg) =>
        options.writes?.push({ method: 'insert', table, arg }),
      ),
    update: (table: unknown) =>
      chain(updateResults.shift() ?? [], (arg) =>
        options.writes?.push({ method: 'update', table, arg }),
      ),
    selectCount: () => selects,
  };
  return db as unknown as Deps['db'] & { selectCount: () => number };
}

const baseConfig = {
  INGEST_API_KEY: 'test-key',
  SOWER_ENV: 'test',
  CLAUDE_CODE_OAUTH_TOKEN: 'oauth-tok',
} as unknown as Config;

function createDeps(db: Deps['db'], config: Partial<Config> = {}): Deps {
  return {
    db,
    queue: { enqueueProcess: async () => {} },
    config: { ...baseConfig, ...config } as Config,
    logger: false,
  };
}

const TASK_ID = 'aaaaaaaa-0000-4000-8000-000000000001';
const FOLLOWUP_ID = 'bbbbbbbb-0000-4000-8000-000000000001';
const AUTH = { 'x-api-key': 'test-key' };

const SOURCE_BODY =
  'From: Google <noreply-local-guides@google.com>\n' +
  'Subject: Chipotle Mexican Grill replied to your review\n' +
  'Date: 2026-07-18T15:00:00.000Z\n\n' +
  'Chipotle Mexican Grill has responded to the review you left.';

/** An email-ingested followups row as the audit's join returns it. */
function auditRow(overrides: Partial<Record<string, unknown>> = {}) {
  const followup = {
    id: FOLLOWUP_ID,
    taskId: TASK_ID,
    kind: 'recruiter',
    title: 'Recruiter — Chipotle Mexican Grill replied to your review',
    state: 'RECEIVED',
    url: null,
    notes: null,
    dueDate: null,
    source: 'email',
    sourceRef: 'm1',
    sourceBody: SOURCE_BODY,
    calendarEventId: null,
    createdAt: new Date('2026-07-18T16:00:00Z'),
    updatedAt: new Date('2026-07-18T16:00:00Z'),
  };
  return {
    followup: { ...followup, ...overrides },
    company: 'Google',
    jobTitle: 'Software Engineer Intern',
  };
}

async function postAudit(deps: Deps) {
  const app = buildServer(deps);
  const response = await app.inject({
    method: 'POST',
    url: '/followups/audit',
    headers: AUTH,
  });
  await app.close();
  return response;
}

beforeEach(() => {
  calendarState.calls = [];
  judgeState.calls = [];
  judgeState.results = [];
});

describe('POST /followups/audit', () => {
  it('is a no-op {enabled:false} without CLAUDE_CODE_OAUTH_TOKEN', async () => {
    const db = createFakeDb();
    const response = await postAudit(
      createDeps(db, { CLAUDE_CODE_OAUTH_TOKEN: undefined }),
    );
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      enabled: false,
      audited: 0,
      dismissed: [],
      kept: 0,
      unjudgeable: 0,
    });
    expect(db.selectCount()).toBe(0);
    expect(judgeState.calls).toHaveLength(0);
  });

  it('DISMISSes high-confidence noise through the shared transition path, reason recorded', async () => {
    const writes: DbWrite[] = [];
    const row = auditRow();
    const db = createFakeDb({
      selectResults: [[row]],
      updateResults: [[{ ...row.followup, state: 'DISMISSED' }]],
      writes,
    });
    judgeState.results = [
      {
        verdict: 'noise',
        confidence: 'high',
        reason: 'a Maps review notification, not about the candidacy',
      },
    ];

    const response = await postAudit(createDeps(db));

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      enabled: true,
      audited: 1,
      dismissed: [
        {
          id: FOLLOWUP_ID,
          title: 'Recruiter — Chipotle Mexican Grill replied to your review',
          reason: 'a Maps review notification, not about the candidacy',
        },
      ],
      kept: 0,
      unjudgeable: 0,
    });
    // The judge re-read the STORED email, headers re-parsed out.
    expect(judgeState.calls[0]).toEqual({
      subject: 'Chipotle Mexican Grill replied to your review',
      from: 'Google <noreply-local-guides@google.com>',
      bodyText: 'Chipotle Mexican Grill has responded to the review you left.',
      company: 'Google',
      jobTitle: 'Software Engineer Intern',
      regexKind: 'recruiter',
    });
    const updateWrite = writes.find(
      (w) => w.method === 'update' && w.table === followups,
    );
    expect(updateWrite?.arg).toMatchObject({ state: 'DISMISSED' });
    const eventWrite = writes.find(
      (w) => w.method === 'insert' && w.table === events,
    );
    expect(eventWrite?.arg).toEqual({
      taskId: TASK_ID,
      type: 'FOLLOWUP_STATE',
      data: {
        followupId: FOLLOWUP_ID,
        event: 'DISMISS',
        from: 'RECEIVED',
        to: 'DISMISSED',
        reason: 'a Maps review notification, not about the candidacy',
        via: 'audit',
      },
    });
    expect(calendarState.calls).toEqual([FOLLOWUP_ID]);
  });

  it('leaves low-confidence noise and followup verdicts untouched (kept)', async () => {
    const writes: DbWrite[] = [];
    const OTHER_ID = 'bbbbbbbb-0000-4000-8000-000000000002';
    const db = createFakeDb({
      selectResults: [
        [auditRow(), auditRow({ id: OTHER_ID, sourceRef: 'm2' })],
      ],
      writes,
    });
    judgeState.results = [
      { verdict: 'noise', confidence: 'low', reason: 'unsure' },
      {
        verdict: 'followup',
        kind: 'recruiter',
        confidence: 'high',
        reason: 'about their specific application',
      },
    ];

    const response = await postAudit(createDeps(db));

    expect(response.json()).toEqual({
      enabled: true,
      audited: 2,
      dismissed: [],
      kept: 2,
      unjudgeable: 0,
    });
    expect(writes).toHaveLength(0);
    expect(calendarState.calls).toEqual([]);
  });

  it('counts judge failures and unparseable source bodies as unjudgeable, untouched', async () => {
    const writes: DbWrite[] = [];
    const OTHER_ID = 'bbbbbbbb-0000-4000-8000-000000000002';
    const db = createFakeDb({
      selectResults: [
        [
          auditRow(),
          auditRow({
            id: OTHER_ID,
            sourceRef: 'm2',
            sourceBody: 'not an email header block',
          }),
        ],
      ],
      writes,
    });
    judgeState.results = [null];

    const response = await postAudit(createDeps(db));

    expect(response.json()).toEqual({
      enabled: true,
      audited: 2,
      dismissed: [],
      kept: 0,
      unjudgeable: 2,
    });
    // The unparseable row never reached the judge at all.
    expect(judgeState.calls).toHaveLength(1);
    expect(writes).toHaveLength(0);
  });

  it('treats a lost transition race as unjudgeable — never a dismissal', async () => {
    const writes: DbWrite[] = [];
    const db = createFakeDb({
      selectResults: [[auditRow()]],
      // The state-guarded update matched 0 rows (a concurrent transition).
      updateResults: [[]],
      writes,
    });
    judgeState.results = [
      { verdict: 'noise', confidence: 'high', reason: 'noise' },
    ];

    const response = await postAudit(createDeps(db));

    expect(response.json()).toEqual({
      enabled: true,
      audited: 1,
      dismissed: [],
      kept: 0,
      unjudgeable: 1,
    });
    expect(writes.filter((w) => w.table === events)).toHaveLength(0);
    expect(calendarState.calls).toEqual([]);
  });
});

describe('parseEmailSourceBody', () => {
  it('re-parses the From/Subject header prefix and body', () => {
    expect(parseEmailSourceBody(SOURCE_BODY)).toEqual({
      from: 'Google <noreply-local-guides@google.com>',
      subject: 'Chipotle Mexican Grill replied to your review',
      body: 'Chipotle Mexican Grill has responded to the review you left.',
    });
  });

  it('handles a truncated (cap-cut) body and missing blank line', () => {
    expect(
      parseEmailSourceBody('From: a@b.c\nSubject: s\nDate: unknown'),
    ).toEqual({ from: 'a@b.c', subject: 's', body: '' });
  });

  it('rejects text that is not the emailSourceBody shape', () => {
    expect(parseEmailSourceBody('')).toBeNull();
    expect(
      parseEmailSourceBody('Subject: s\nFrom: a@b.c\nDate: d\n\nx'),
    ).toBeNull();
    expect(parseEmailSourceBody('From: a@b.c\nSubject: s\n')).toBeNull();
  });
});
