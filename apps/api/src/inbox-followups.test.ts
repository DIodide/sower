import { events, followups } from '@sower/db';
import type { GmailMessageSummary } from '@sower/inbox';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from './config.js';
import {
  allowedFollowupUrl,
  emailBodyToPlainText,
  emailSourceBody,
  type FollowupMailbox,
  runFollowupInboxPoll,
} from './inbox-followups.js';
import type { Deps, Notifier } from './types.js';

/**
 * The follow-up inbox poll with an injected fake Gmail + notify: gating on
 * the OAuth triple, company-token matching, source_ref dedupe, classifier
 * null-skips, the per-run creation cap, and the #alerts note. The
 * classifier itself is proven in @sower/inbox; the calendar sync in
 * calendar-sync.test.ts (mocked here).
 */

const calendarState = vi.hoisted(() => ({ calls: [] as string[] }));

vi.mock('./calendar-sync.js', () => ({
  syncFollowupCalendarEvent: vi.fn(
    async (_deps: unknown, followupId: string) => {
      calendarState.calls.push(followupId);
      return { kind: 'created', eventId: 'evt-1' };
    },
  ),
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
    writes?: DbWrite[];
  } = {},
): Deps['db'] & { selectCount: () => number } {
  const selectResults = [...(options.selectResults ?? [])];
  const insertResults = [...(options.insertResults ?? [])];
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
      chain([], (arg) =>
        options.writes?.push({ method: 'update', table, arg }),
      ),
    selectCount: () => selects,
  };
  return db as unknown as Deps['db'] & { selectCount: () => number };
}

const baseConfig = {
  INGEST_API_KEY: 'test-key',
  SOWER_ENV: 'test',
  GMAIL_CLIENT_ID: 'cid',
  GMAIL_CLIENT_SECRET: 'csec',
  GMAIL_REFRESH_TOKEN: 'rtok',
  DISCORD_BOT_TOKEN: 'tok',
  DISCORD_ENABLED: true,
  DISCORD_ALERTS_CHANNEL_ID: 'chan-alerts',
  DASHBOARD_BASE_URL: 'https://dash.example',
} as unknown as Config;

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
    config: { ...baseConfig, ...overrides.config } as Config,
    notify: 'notify' in overrides ? overrides.notify : createNotify(),
    logger: false,
  };
}

function createMailbox(messages: GmailMessageSummary[]): FollowupMailbox {
  return {
    searchMessageIds: vi.fn(async () => messages.map((m) => m.id)),
    readMessage: vi.fn(
      async (id: string) => messages.find((m) => m.id === id) ?? null,
    ),
  };
}

const TASK_ID = 'aaaaaaaa-0000-4000-8000-000000000001';
const FOLLOWUP_ID = 'bbbbbbbb-0000-4000-8000-000000000001';

/** The Akuna-shaped OA invite the classifier is proven against. */
function akunaMessage(id = 'm1'): GmailMessageSummary {
  return {
    id,
    subject: 'Akuna Capital - Online Assessment Invitation',
    from: 'Akuna Capital <no-reply@hackerrankforwork.com>',
    receivedAt: new Date('2026-07-18T15:00:00Z'),
    bodyText:
      'Please complete your coding challenge within 7 days: https://www.hackerrankforwork.com/tests/abc123/login',
  };
}

/** The header + body emailSourceBody derives from akunaMessage(). */
const AKUNA_SOURCE_BODY =
  'From: Akuna Capital <no-reply@hackerrankforwork.com>\n' +
  'Subject: Akuna Capital - Online Assessment Invitation\n' +
  'Date: 2026-07-18T15:00:00.000Z\n\n' +
  'Please complete your coding challenge within 7 days: https://www.hackerrankforwork.com/tests/abc123/login';

/** The followups row the fake insert returns. */
function createdRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: FOLLOWUP_ID,
    taskId: TASK_ID,
    kind: 'assessment',
    title: 'Assessment — Akuna Capital - Online Assessment Invitation',
    state: 'RECEIVED',
    url: 'https://www.hackerrankforwork.com/tests/abc123/login',
    notes: null,
    dueDate: new Date('2026-07-25T04:00:00.000Z'),
    source: 'email',
    sourceRef: 'm1',
    sourceBody: AKUNA_SOURCE_BODY,
    calendarEventId: null,
    createdAt: new Date('2026-07-18T16:00:00Z'),
    updatedAt: new Date('2026-07-18T16:00:00Z'),
    ...overrides,
  };
}

const SENT_TASKS = [
  { taskId: TASK_ID, company: 'Akuna Capital', title: 'SWE Intern' },
];

beforeEach(() => {
  calendarState.calls = [];
});

describe('runFollowupInboxPoll', () => {
  it('is a no-op {enabled:false} until the Gmail OAuth triple is configured', async () => {
    const mailbox = createMailbox([akunaMessage()]);
    for (const config of [
      { GMAIL_REFRESH_TOKEN: undefined },
      { GMAIL_CLIENT_ID: undefined },
      { GMAIL_CLIENT_SECRET: undefined },
    ]) {
      const db = createFakeDb();
      const result = await runFollowupInboxPoll(
        createDeps({ config, db }),
        mailbox,
      );
      expect(result).toEqual({
        enabled: false,
        scanned: 0,
        matched: 0,
        created: 0,
        skipped: 0,
      });
      expect(db.selectCount()).toBe(0);
    }
    expect(mailbox.searchMessageIds).not.toHaveBeenCalled();
  });

  it('creates a follow-up from a matched OA invite: source email, sourceRef, ET-midnight dueDate, event, sync, #alerts note', async () => {
    const writes: DbWrite[] = [];
    const db = createFakeDb({
      // Sent tasks, then the (empty) source_ref dedupe probe.
      selectResults: [SENT_TASKS, []],
      insertResults: [[createdRow()], []],
      writes,
    });
    const notify = createNotify();
    const mailbox = createMailbox([akunaMessage()]);

    const result = await runFollowupInboxPoll(
      createDeps({ db, notify }),
      mailbox,
    );

    expect(result).toEqual({
      enabled: true,
      scanned: 1,
      matched: 1,
      created: 1,
      skipped: 0,
    });
    const followupWrite = writes.find(
      (w) => w.method === 'insert' && w.table === followups,
    );
    expect(followupWrite?.arg).toEqual({
      taskId: TASK_ID,
      kind: 'assessment',
      title: 'Assessment — Akuna Capital - Online Assessment Invitation',
      state: 'RECEIVED',
      url: 'https://www.hackerrankforwork.com/tests/abc123/login',
      // "within 7 days" of ET July 18, normalized to ET midnight (EDT).
      dueDate: new Date('2026-07-25T04:00:00.000Z'),
      source: 'email',
      sourceRef: 'm1',
      sourceBody: AKUNA_SOURCE_BODY,
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
        title: 'Assessment — Akuna Capital - Online Assessment Invitation',
        source: 'email',
      },
    });
    expect(calendarState.calls).toEqual([FOLLOWUP_ID]);
    expect(notify.postChannelMessage).toHaveBeenCalledTimes(1);
    const [channel, text] = vi.mocked(notify.postChannelMessage).mock
      .calls[0] ?? ['', ''];
    expect(channel).toBe('chan-alerts');
    expect(text).toBe(
      '📬 Assessment for **Akuna Capital** — Assessment — Akuna Capital - Online Assessment Invitation · ' +
        `[open in sower](https://dash.example/followups/${FOLLOWUP_ID})`,
    );
  });

  it('dedupes on source_ref without even reading the message', async () => {
    const db = createFakeDb({
      selectResults: [SENT_TASKS, [{ sourceRef: 'm1' }]],
    });
    const mailbox = createMailbox([akunaMessage()]);

    const result = await runFollowupInboxPoll(createDeps({ db }), mailbox);

    expect(result).toEqual({
      enabled: true,
      scanned: 1,
      matched: 0,
      created: 0,
      skipped: 1,
    });
    expect(mailbox.readMessage).not.toHaveBeenCalled();
  });

  it('skips mail that matches no sent application (no company token)', async () => {
    const writes: DbWrite[] = [];
    const db = createFakeDb({ selectResults: [SENT_TASKS, []], writes });
    const mailbox = createMailbox([
      {
        id: 'm2',
        subject: 'Interview with SomeOtherCo',
        from: 'recruiter@someotherco.com',
        receivedAt: new Date('2026-07-18T15:00:00Z'),
        bodyText: 'We would love to schedule a call.',
      },
    ]);

    const result = await runFollowupInboxPoll(createDeps({ db }), mailbox);

    expect(result).toEqual({
      enabled: true,
      scanned: 1,
      matched: 0,
      created: 0,
      skipped: 1,
    });
    expect(writes).toHaveLength(0);
  });

  it('never matches by content alone: an untrusted sender naming the company is rejected', async () => {
    // The forged-follow-up attack: anyone can SAY "Akuna Capital" in a
    // subject/body. Matching is sender-anchored — an arbitrary domain
    // (LinkedIn digests, but equally an attacker's mail) never attaches,
    // no matter how many company tokens the content carries.
    const writes: DbWrite[] = [];
    const db = createFakeDb({ selectResults: [SENT_TASKS, []], writes });
    const mailbox = createMailbox([
      {
        id: 'm3',
        subject: 'Jobs like SWE Intern at Akuna Capital',
        from: 'LinkedIn <jobs-noreply@linkedin.com>',
        receivedAt: new Date('2026-07-18T15:00:00Z'),
        bodyText: 'Akuna Capital and 9 other companies are hiring. akuna akuna',
      },
      {
        id: 'm4',
        subject: 'Your Akuna Capital HackerRank is ready',
        from: 'totally-real <recruiting@akuna-capital.attacker.io>',
        receivedAt: new Date('2026-07-18T15:01:00Z'),
        bodyText:
          'Complete your Akuna Capital assessment: https://evil.example',
      },
    ]);

    const result = await runFollowupInboxPoll(createDeps({ db }), mailbox);

    expect(result).toEqual({
      enabled: true,
      scanned: 2,
      matched: 0,
      created: 0,
      skipped: 2,
    });
    expect(writes).toHaveLength(0);
  });

  it('lands generic recruiting mail on the real application, not the fresher same-company event task', async () => {
    const EVENT_TASK_ID = 'aaaaaaaa-0000-4000-8000-000000000002';
    // Most-recently-updated first: the event registration would win the old
    // freshest-task rule (the live Jane Street misfile).
    const tasks = [
      {
        taskId: EVENT_TASK_ID,
        company: 'Jane Street',
        title: 'Mystery Planet in NYC (Event Registration)',
      },
      {
        taskId: TASK_ID,
        company: 'Jane Street',
        title: 'Software Engineer Internship',
      },
    ];
    const writes: DbWrite[] = [];
    const db = createFakeDb({
      selectResults: [tasks, []],
      insertResults: [[createdRow()], []],
      writes,
    });
    const mailbox = createMailbox([
      {
        id: 'm6',
        subject: 'Jane Street — an update on your application',
        from: 'Jane Street Recruiting <no-reply@janestreet.com>',
        receivedAt: new Date('2026-07-18T15:00:00Z'),
        bodyText: 'A recruiter will reach out with next steps.',
      },
    ]);

    const result = await runFollowupInboxPoll(createDeps({ db }), mailbox);

    expect(result.created).toBe(1);
    const followupWrite = writes.find(
      (w) => w.method === 'insert' && w.table === followups,
    );
    expect(followupWrite?.arg).toMatchObject({ taskId: TASK_ID });
  });

  it('steers mail naming a role to that application by title overlap, not recency', async () => {
    const PLATFORM_TASK_ID = 'aaaaaaaa-0000-4000-8000-000000000003';
    const tasks = [
      {
        taskId: TASK_ID,
        company: 'Initech',
        title: 'Software Engineer Internship',
      },
      {
        taskId: PLATFORM_TASK_ID,
        company: 'Initech',
        title: 'Platform Engineer Internship',
      },
    ];
    const writes: DbWrite[] = [];
    const db = createFakeDb({
      selectResults: [tasks, []],
      insertResults: [[createdRow()], []],
      writes,
    });
    const mailbox = createMailbox([
      {
        id: 'm7',
        subject: 'Interview — Platform Engineer',
        from: 'recruiting@initech.com',
        receivedAt: new Date('2026-07-18T15:00:00Z'),
        bodyText:
          'We would like to schedule an interview for the Platform Engineer role.',
      },
    ]);

    const result = await runFollowupInboxPoll(createDeps({ db }), mailbox);

    expect(result.created).toBe(1);
    const followupWrite = writes.find(
      (w) => w.method === 'insert' && w.table === followups,
    );
    expect(followupWrite?.arg).toMatchObject({ taskId: PLATFORM_TASK_ID });
  });

  it('still attaches event mail to the event task when its title overlap strictly wins', async () => {
    const EVENT_TASK_ID = 'aaaaaaaa-0000-4000-8000-000000000002';
    const tasks = [
      {
        taskId: EVENT_TASK_ID,
        company: 'Jane Street',
        title: 'Mystery Planet in NYC (Event Registration)',
      },
      {
        taskId: TASK_ID,
        company: 'Jane Street',
        title: 'Software Engineer Internship',
      },
    ];
    const writes: DbWrite[] = [];
    const db = createFakeDb({
      selectResults: [tasks, []],
      insertResults: [[createdRow()], []],
      writes,
    });
    const mailbox = createMailbox([
      {
        id: 'm8',
        subject: 'Mystery Planet in NYC — registration confirmed',
        from: 'events@janestreet.com',
        receivedAt: new Date('2026-07-18T15:00:00Z'),
        bodyText:
          'Thanks for registering. We look forward to this opportunity to meet you at our Mystery Planet event.',
      },
    ]);

    const result = await runFollowupInboxPoll(createDeps({ db }), mailbox);

    expect(result.created).toBe(1);
    const followupWrite = writes.find(
      (w) => w.method === 'insert' && w.table === followups,
    );
    expect(followupWrite?.arg).toMatchObject({ taskId: EVENT_TASK_ID });
  });

  it('treats a lost insert race (ON CONFLICT DO NOTHING) as a skip: no event, no sync, no note', async () => {
    const writes: DbWrite[] = [];
    const db = createFakeDb({
      selectResults: [SENT_TASKS, []],
      // The conflict-suppressed insert returns no row.
      insertResults: [[]],
      writes,
    });
    const notify = createNotify();

    const result = await runFollowupInboxPoll(
      createDeps({ db, notify }),
      createMailbox([akunaMessage()]),
    );

    expect(result).toEqual({
      enabled: true,
      scanned: 1,
      matched: 1,
      created: 0,
      skipped: 1,
    });
    expect(writes.filter((w) => w.table === events)).toHaveLength(0);
    expect(calendarState.calls).toEqual([]);
    expect(notify.postChannelMessage).not.toHaveBeenCalled();
  });

  it('caps creations at 10 per run and counts the rest as skipped', async () => {
    const messages = Array.from({ length: 12 }, (_, i) =>
      akunaMessage(`m${i}`),
    );
    const insertResults: unknown[][] = [];
    for (let i = 0; i < 12; i += 1) {
      insertResults.push(
        [
          createdRow({
            id: `cccccccc-0000-4000-8000-${String(i).padStart(12, '0')}`,
            sourceRef: `m${i}`,
          }),
        ],
        [],
      );
    }
    const writes: DbWrite[] = [];
    const db = createFakeDb({
      selectResults: [SENT_TASKS, []],
      insertResults,
      writes,
    });

    const result = await runFollowupInboxPoll(
      createDeps({ db }),
      createMailbox(messages),
    );

    expect(result).toEqual({
      enabled: true,
      scanned: 12,
      matched: 10,
      created: 10,
      skipped: 2,
    });
    expect(
      writes.filter((w) => w.method === 'insert' && w.table === followups),
    ).toHaveLength(10);
  });

  it('still creates (silently) when the alerts channel is unset', async () => {
    const notify = createNotify();
    const db = createFakeDb({
      selectResults: [SENT_TASKS, []],
      insertResults: [[createdRow()], []],
    });

    const result = await runFollowupInboxPoll(
      createDeps({
        db,
        notify,
        config: { DISCORD_ALERTS_CHANNEL_ID: undefined },
      }),
      createMailbox([akunaMessage()]),
    );

    expect(result.created).toBe(1);
    expect(notify.postChannelMessage).not.toHaveBeenCalled();
  });

  it('a failed #alerts note never fails the poll', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const notify = createNotify();
    vi.mocked(notify.postChannelMessage).mockRejectedValueOnce(
      new Error('discord 500'),
    );
    const db = createFakeDb({
      selectResults: [SENT_TASKS, []],
      insertResults: [[createdRow()], []],
    });

    const result = await runFollowupInboxPoll(
      createDeps({ db, notify }),
      createMailbox([akunaMessage()]),
    );

    expect(result.created).toBe(1);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('emailSourceBody', () => {
  it('prefixes From/Subject/Date and keeps a plain-text body verbatim', () => {
    expect(emailSourceBody(akunaMessage())).toBe(AKUNA_SOURCE_BODY);
  });

  it('caps the stored text at 20k chars', () => {
    const message = { ...akunaMessage(), bodyText: 'x'.repeat(30_000) };
    const body = emailSourceBody(message);
    expect(body).toHaveLength(20_000);
    expect(body.startsWith('From: Akuna Capital')).toBe(true);
  });

  it('reports a missing receivedAt as unknown', () => {
    const body = emailSourceBody({ ...akunaMessage(), receivedAt: null });
    expect(body).toContain('Date: unknown\n');
  });
});

describe('emailBodyToPlainText', () => {
  it('strips tags (style/script wholesale), decodes entities, and collapses blank runs', () => {
    expect(
      emailBodyToPlainText(
        '<div style="font-family: Arial"><p>You&#39;re invited &amp; welcome.</p><br>' +
          '<p>See you &lt;soon&gt;&nbsp;&mdash; the team</p>' +
          '<style>p { color: red }</style><script>alert("x")</script></div>',
      ),
    ).toBe("You're invited & welcome.\n\nSee you <soon> — the team");
  });

  it('leaves unknown entities and invalid numeric references intact', () => {
    expect(emailBodyToPlainText('a &bogus; b &#xdddddddd; c')).toBe(
      'a &bogus; b &#xdddddddd; c',
    );
  });
});

describe('allowedFollowupUrl', () => {
  it('keeps https urls on the assessment/scheduling allowlists (subdomains included)', () => {
    expect(allowedFollowupUrl('https://www.hackerrank.com/tests/abc')).toBe(
      'https://www.hackerrank.com/tests/abc',
    );
    expect(allowedFollowupUrl('https://calendly.com/jane/30min')).toBe(
      'https://calendly.com/jane/30min',
    );
    expect(allowedFollowupUrl('https://app.goodtime.io/invite/x')).toBe(
      'https://app.goodtime.io/invite/x',
    );
  });

  it('drops http, off-list hosts, lookalikes, and garbage', () => {
    expect(allowedFollowupUrl('http://www.hackerrank.com/t')).toBeNull();
    expect(allowedFollowupUrl('https://evil.example/phish')).toBeNull();
    expect(allowedFollowupUrl('https://nothackerrank.com/t')).toBeNull();
    expect(allowedFollowupUrl('not a url')).toBeNull();
    expect(allowedFollowupUrl(undefined)).toBeNull();
  });
});
