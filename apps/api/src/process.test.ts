import { createHash } from 'node:crypto';
import { jobs as jobsTable } from '@sower/db';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from './config.js';
import { refreshIngestReply } from './ingest-reply.js';
import { MAX_ATTEMPTS, processTask } from './process.js';
import type { Deps, Notifier } from './types.js';

const adapterState = vi.hoisted(() => ({
  discoverError: null as string | null,
  questions: [] as unknown[],
  lastDiscoverOpts: undefined as { recorder?: unknown } | undefined,
  /** The PlatformRef discover was called with (tenant self-heal assertions). */
  lastDiscoverRef: undefined as { tenant?: string | null } | undefined,
  // Contract D: optional spec fields the discover mock echoes back so tests can
  // exercise company/title backfill and description versioning.
  company: undefined as string | undefined,
  title: undefined as string | undefined,
  description: undefined as string | undefined,
  employmentType: undefined as string | undefined,
  deadline: undefined as string | undefined,
  formAccess: undefined as 'public' | 'account-required' | undefined,
}));

const answersState = vi.hoisted(() => ({
  result: { resolved: [], missing: [] } as {
    resolved: unknown[];
    missing: unknown[];
  },
  lastOpts: undefined as unknown,
}));

// Controls the Workday questionnaire-read path (enrichWorkdayQuestionnaire):
// the adapter returns account-required with meta.questionnaireId; the pipeline
// then loads a session and reads the questionnaire. These knobs stand in for
// the vault session, the posting's questionnaireId, the read result, and any
// read failure.
const workdayState = vi.hoisted(() => ({
  session: null as unknown,
  questionnaireId: null as string | null,
  fields: [] as unknown[],
  readError: null as string | null,
  getQuestionnaireCalls: [] as string[],
}));

/** Verified greenhouse tenant probe: what it reports + how it was called. */
const probeState = vi.hoisted(() => ({
  tenant: null as string | null,
  calls: [] as Array<{ url: string; jobId: string }>,
}));

vi.mock('@sower/platforms', () => ({
  // link-extract.ts (imported by process.ts for trailingNumericJobId) also
  // pulls detectPlatform from this module; the stub keeps the mocked module
  // graph loadable — nothing in these tests exercises it.
  detectPlatform: () => ({
    platform: 'unknown',
    tenant: null,
    externalId: null,
  }),
  deriveGreenhouseTenant: async (url: string, jobId: string) => {
    probeState.calls.push({ url, jobId });
    return probeState.tenant;
  },
  getAdapter: (platform: string) => {
    if (platform === 'greenhouse') {
      return {
        discover: async (
          ref: { tenant?: string | null },
          _url: unknown,
          opts?: { recorder?: unknown },
        ) => {
          adapterState.lastDiscoverOpts = opts;
          adapterState.lastDiscoverRef = ref;
          if (adapterState.discoverError) {
            throw new Error(adapterState.discoverError);
          }
          return {
            platform: 'greenhouse',
            tenant: 'acme',
            externalId: 'swe-1',
            title: adapterState.title ?? 'Software Engineer Intern',
            applyUrl: 'https://boards.greenhouse.io/acme/jobs/123',
            questions: adapterState.questions,
            ...(adapterState.company !== undefined
              ? { company: adapterState.company }
              : {}),
            ...(adapterState.description !== undefined
              ? { description: adapterState.description }
              : {}),
            ...(adapterState.employmentType !== undefined
              ? { employmentType: adapterState.employmentType }
              : {}),
            ...(adapterState.deadline !== undefined
              ? { deadline: adapterState.deadline }
              : {}),
            ...(adapterState.formAccess !== undefined
              ? { formAccess: adapterState.formAccess }
              : {}),
          };
        },
        submit: async () => {
          throw new Error('submit disabled');
        },
      };
    }
    if (platform === 'workday') {
      return {
        discover: async (
          _ref: unknown,
          _url: unknown,
          opts?: { recorder?: unknown },
        ) => {
          adapterState.lastDiscoverOpts = opts;
          if (adapterState.discoverError) {
            throw new Error(adapterState.discoverError);
          }
          // The adapter always returns account-required with NO questions; the
          // questionnaireId (when the posting advertises one) rides in meta.
          return {
            platform: 'workday',
            tenant: 'acme-wd',
            externalId: 'wd-1',
            title: 'Software Engineering Intern',
            applyUrl: 'https://acme.wd1.myworkdayjobs.com/external/job/x/SWE_1',
            questions: [],
            formAccess: 'account-required',
            meta: {
              site: 'External',
              externalPath: '/job/x/SWE_1',
              questionnaireId: workdayState.questionnaireId,
            },
          };
        },
        submit: async () => {
          throw new Error('submit disabled');
        },
      };
    }
    return null;
  },
  loadWorkdaySession: async (_vault: unknown, _tenant: string) =>
    workdayState.session,
  // The pure field→Question mapping is unit-tested in @sower/platforms; here a
  // passthrough keeps the pipeline assertions decoupled from that mapping.
  workdayFieldsToQuestions: (fields: unknown[]) => fields,
  CalypsoClient: class {
    async getQuestionnaire(id: string) {
      workdayState.getQuestionnaireCalls.push(id);
      if (workdayState.readError) {
        throw new Error(workdayState.readError);
      }
      return workdayState.fields;
    }
  },
}));

const profileState = vi.hoisted(() => ({
  /** What getProfile resolves; `empty: true` marks the empty sentinel. */
  profile: {} as Record<string, unknown>,
}));

vi.mock('@sower/answers', () => ({
  getProfile: async () => profileState.profile,
  // The real isEmptyProfile checks the identity fields; the fake keys off a
  // bare marker so tests can flip emptiness without building full profiles.
  isEmptyProfile: (profile: Record<string, unknown>) => profile.empty === true,
  resolveAnswers: (_questions: unknown, _profile: unknown, opts?: unknown) => {
    answersState.lastOpts = opts;
    return answersState.result;
  },
}));

// The post-parse #ingest reply refresh (label upgrade to "Title · Company"):
// mocked so tests assert exactly when the successful-parse path fires it.
vi.mock('./ingest-reply.js', () => ({
  refreshIngestReply: vi.fn(async () => {}),
}));

/** Jobs whose tasks processTask asked the calendar sync to bring in line. */
const calendarSyncState = vi.hoisted(() => ({ jobCalls: [] as string[] }));

// The sync itself is proven in calendar-sync.test.ts; here we only assert
// the deadline-persist path fires it (it self-gates and never throws).
vi.mock('./calendar-sync.js', () => ({
  syncCalendarEventsForJob: vi.fn(async (_deps: unknown, jobId: string) => {
    calendarSyncState.jobCalls.push(jobId);
  }),
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

interface FakeJobRow {
  id: string;
  url: string;
  canonicalUrl: string;
  dedupeKey: string;
  platform: string;
  tenant: string | null;
  externalId: string | null;
  company: string | null;
  title: string | null;
  deadline: Date | null;
}

interface FakeDescriptionRow {
  jobId: string;
  version: number;
  content: string;
  contentHash: string;
}

/**
 * Stateful fake db holding a single task row. Mimics the drizzle surface
 * processTask uses. The claim (`update ... returning()`) is applied atomically
 * at await-time so concurrent claims race exactly like they would against
 * Postgres: only one caller gets the row back.
 */
function createFakeTaskDb(initial: {
  state: string;
  attempt?: number;
  company?: string | null;
  title?: string | null;
  descriptions?: FakeDescriptionRow[];
  /** answers-table rows the bank select resolves (company '' = global). */
  bank?: Array<{ normalizedLabel: string; value: unknown; company: string }>;
  /** Platform of the job row; defaults to greenhouse. */
  platform?: string;
  /** Pre-existing jobs.deadline (never overwritten by the persist rule). */
  deadline?: Date | null;
  /** Pre-existing event history (e.g. a RESTORE from a human un-discard). */
  events?: FakeEventRow[];
  /** Job tenant override; pass null for a tenant-less (parked) greenhouse job. */
  tenant?: string | null;
  /** Job url override (e.g. a custom-domain gh_jid URL). */
  url?: string;
  /** Job externalId override. */
  externalId?: string | null;
  /** Pre-existing tasks.last_error (e.g. from an earlier FAILED attempt). */
  lastError?: string | null;
  /**
   * When set, the tenant self-heal's canonical-collision select (FROM jobs)
   * reports this OTHER job as already owning the canonical board identity.
   */
  collidingJobId?: string;
}) {
  const task: FakeTaskRow = {
    id: 'task-1',
    jobId: 'job-1',
    state: initial.state,
    attempt: initial.attempt ?? 0,
    jobSpec: null,
    resolution: null,
    lastError: initial.lastError ?? null,
    updatedAt: new Date(0),
  };
  const isWorkday = initial.platform === 'workday';
  const url =
    initial.url ??
    (isWorkday
      ? 'https://acme.wd1.myworkdayjobs.com/external/job/x/SWE_1'
      : 'https://boards.greenhouse.io/acme/jobs/123');
  const job: FakeJobRow = {
    id: 'job-1',
    url,
    canonicalUrl: url,
    dedupeKey: url,
    platform: initial.platform ?? 'greenhouse',
    tenant:
      initial.tenant !== undefined
        ? initial.tenant
        : isWorkday
          ? 'acme-wd'
          : 'acme',
    externalId:
      initial.externalId !== undefined
        ? initial.externalId
        : isWorkday
          ? 'wd-1'
          : 'swe-1',
    company: initial.company ?? null,
    title: initial.title ?? null,
    deadline: initial.deadline ?? null,
  };
  const eventRows: FakeEventRow[] = [...(initial.events ?? [])];
  const descriptionRows: FakeDescriptionRow[] = initial.descriptions ?? [];
  const bankRows = initial.bank ?? [];

  // A jobs write sets only jobs columns (company/title backfill, tenant
  // self-heal adoption); everything else (claim, jobSpec, resolution,
  // transitions) targets the task row.
  const JOB_COLUMNS = new Set([
    'company',
    'title',
    'platform',
    'tenant',
    'externalId',
    'url',
    'canonicalUrl',
    'dedupeKey',
    'deadline',
  ]);
  const isJobUpdate = (setArg: Record<string, unknown>) => {
    const keys = Object.keys(setArg);
    return keys.length > 0 && keys.every((k) => JOB_COLUMNS.has(k));
  };

  const db = {
    select: (fields?: Record<string, unknown>) => {
      // Result is computed lazily (at await time) so the FROM table — captured
      // below — can disambiguate selects with identical field shapes (the
      // RESTORE-event guard and the jobs canonical-collision check both select
      // a single `id`).
      let fromTable: unknown;
      const computeResult = (): unknown[] => {
        if (fromTable === jobsTable) {
          // The tenant self-heal's canonical-collision check.
          return initial.collidingJobId ? [{ id: initial.collidingJobId }] : [];
        }
        // Bank (answers) and documents selects resolve empty; a
        // job_descriptions select resolves the latest stored version (desc by
        // version, limit 1); the task+job lookup resolves the single task row.
        const isBankSelect =
          fields !== undefined && 'normalizedLabel' in fields;
        const isDocumentsSelect = fields !== undefined && 'kind' in fields;
        const isDescriptionSelect =
          fields !== undefined && 'contentHash' in fields;
        // The auto-discard RESTORE guard selects only the event id (filtered
        // to type = 'RESTORE' in SQL; the fake applies the filter here).
        const isRestoreEventSelect =
          fields !== undefined &&
          'id' in fields &&
          Object.keys(fields).length === 1;
        if (isRestoreEventSelect) {
          return eventRows
            .filter((event) => event.type === 'RESTORE')
            .map((_, index) => ({ id: `event-${index}` }));
        }
        if (isDescriptionSelect) {
          return [...descriptionRows]
            .sort((a, b) => b.version - a.version)
            .slice(0, 1)
            .map((d) => ({ version: d.version, contentHash: d.contentHash }));
        }
        if (isBankSelect) {
          return bankRows.map((row) => ({ ...row }));
        }
        if (isDocumentsSelect) {
          return [];
        }
        return [{ task: { ...task }, job }];
      };
      const chain = {
        from: (table: unknown) => {
          fromTable = table;
          return chain;
        },
        innerJoin: () => chain,
        where: () => chain,
        orderBy: () => chain,
        limit: () => chain,
        // biome-ignore lint/suspicious/noThenProperty: mimics drizzle's awaitable builder
        then: (onFulfilled: (value: unknown) => unknown) =>
          Promise.resolve().then(computeResult).then(onFulfilled),
      };
      return chain;
    },
    update: () => ({
      set: (setArg: Record<string, unknown>) => ({
        where: () => {
          const applyPlain = () => {
            const target = isJobUpdate(setArg)
              ? (job as unknown as Record<string, unknown>)
              : (task as unknown as Record<string, unknown>);
            for (const [key, value] of Object.entries(setArg)) {
              if (key === 'attempt') continue; // claim-only sql expression
              target[key] = value;
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
      values: (row: FakeEventRow | FakeDescriptionRow) => ({
        // biome-ignore lint/suspicious/noThenProperty: mimics drizzle's awaitable builder
        then: (onFulfilled: (value: unknown) => unknown) =>
          Promise.resolve()
            .then(() => {
              // job_descriptions rows carry content_hash; events do not.
              if ('contentHash' in row) {
                descriptionRows.push(row);
              } else {
                eventRows.push(row);
              }
              return [];
            })
            .then(onFulfilled),
      }),
    }),
  };

  return {
    db: db as unknown as Deps['db'],
    task,
    job,
    eventRows,
    descriptionRows,
  };
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
    postOtpRequestCard: vi.fn(async () => ({
      channelId: 'chan-1',
      messageId: 'otp-msg-1',
    })),
    updateApprovalCard: vi.fn(async () => {}),
    verifyInteraction: vi.fn(() => true),
    applyVerdict: vi.fn(() => ({ embeds: [], components: [] })),
    fetchChannelMessages: vi.fn(async () => []),
    addReaction: vi.fn(async () => {}),
    postChannelMessage: vi.fn(async () => ({ id: 'reply-1' })),
    editChannelMessage: vi.fn(async () => {}),
  } satisfies Notifier;
}

/** Config permutation with Discord enabled (fake token, obviously not real). */
const discordConfig: Config = {
  ...config,
  DISCORD_BOT_TOKEN: 'test-not-a-real-token',
  DISCORD_ENABLED: true,
};

beforeEach(() => {
  vi.mocked(refreshIngestReply).mockClear();
  calendarSyncState.jobCalls = [];
  adapterState.discoverError = null;
  adapterState.questions = [];
  adapterState.lastDiscoverOpts = undefined;
  adapterState.lastDiscoverRef = undefined;
  probeState.tenant = null;
  probeState.calls = [];
  adapterState.company = undefined;
  adapterState.title = undefined;
  adapterState.description = undefined;
  adapterState.employmentType = undefined;
  adapterState.deadline = undefined;
  adapterState.formAccess = undefined;
  answersState.result = { resolved: [], missing: [] };
  answersState.lastOpts = undefined;
  profileState.profile = {};
  workdayState.session = null;
  workdayState.questionnaireId = null;
  workdayState.fields = [];
  workdayState.readError = null;
  workdayState.getQuestionnaireCalls = [];
});

/** sha256 hex of `content`, matching process.ts's content_hash computation. */
function sha256Hex(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

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
    // documents (empty here) + the job's companyKey ('' — the fake job has no
    // company) are passed through to resolveAnswers.
    expect(adapterState.lastDiscoverOpts?.recorder).toBeTypeOf('function');
    expect(answersState.lastOpts).toEqual({
      bank: [],
      documents: [],
      company: '',
    });
  });

  it('parks an account-required spec (workday) in NEEDS_INPUT, never REVIEW', async () => {
    const { db, task, eventRows } = createFakeTaskDb({ state: 'QUEUED' });
    // Workday-shaped discover: no discoverable questions and nothing missing,
    // which would normally resolve to REVIEW — but formAccess forces parking.
    adapterState.formAccess = 'account-required';
    answersState.result = { resolved: [], missing: [] };

    const outcome = await processTask(createDeps(db), 'task-1');

    expect(outcome).toMatchObject({ kind: 'processed', state: 'NEEDS_INPUT' });
    expect(task.state).toBe('NEEDS_INPUT');
    // The resolution explains WHY it parked (surfaced on the dashboard).
    expect((task.resolution as { note?: string }).note).toMatch(/Workday/);
    expect(eventRows.map((e) => [e.type, e.fromState, e.toState])).toEqual([
      ['PROCESS_START', 'QUEUED', 'PREPARING'],
      ['RESOLVED_PARTIAL', 'PREPARING', 'NEEDS_INPUT'],
    ]);
  });

  it('processes WITHOUT failing when no profile is configured, noting it on the resolution', async () => {
    const { db, task } = createFakeTaskDb({ state: 'QUEUED' });
    // The empty-profile sentinel: prod's old behavior was a loadProfile
    // THROW here (ENOENT on the gitignored file), burning attempts with
    // "Failed to read profile file" as lastError. getProfile never throws.
    profileState.profile = { empty: true };
    answersState.result = { resolved: [], missing: [] };

    const outcome = await processTask(createDeps(db), 'task-1');

    expect(outcome).toEqual({
      kind: 'processed',
      state: 'REVIEW',
      resolved: 0,
      missing: 0,
    });
    expect(task.lastError).toBeNull();
    expect((task.resolution as { note?: string }).note).toContain(
      'No profile configured — set one up in Answers → Profile',
    );
  });

  it('joins the no-profile note with the account-required note when both apply', async () => {
    const { db, task } = createFakeTaskDb({ state: 'QUEUED' });
    profileState.profile = { empty: true };
    adapterState.formAccess = 'account-required';

    const outcome = await processTask(createDeps(db), 'task-1');

    expect(outcome).toMatchObject({ kind: 'processed', state: 'NEEDS_INPUT' });
    const note = (task.resolution as { note?: string }).note ?? '';
    expect(note).toMatch(/Workday/);
    expect(note).toContain('No profile configured');
  });

  it('leaves the resolution note unset when a profile is configured', async () => {
    const { db, task } = createFakeTaskDb({ state: 'QUEUED' });
    answersState.result = { resolved: [], missing: [] };

    await processTask(createDeps(db), 'task-1');

    expect((task.resolution as { note?: string }).note).toBeUndefined();
  });

  it('passes the startup-loaded curated answer bank through to resolveAnswers', async () => {
    const { db } = createFakeTaskDb({ state: 'QUEUED' });
    const answerBank = { version: 1 as const, entries: [] };
    answersState.result = { resolved: [], missing: [] };

    await processTask(createDeps(db, { answerBank }), 'task-1');

    expect(answersState.lastOpts).toEqual({
      bank: [],
      documents: [],
      answerBank,
      company: '',
    });
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

describe('processTask Workday questionnaire read (session-gated)', () => {
  // A truthy vault stub; loadWorkdaySession is mocked and ignores it, so only
  // its presence (deps.storage) matters to the pipeline.
  const storage = {} as unknown as NonNullable<Deps['storage']>;
  const workdayQuestion = {
    id: 'q-clearance',
    label: 'Do you have a security clearance?',
    type: 'select',
    required: true,
    options: [
      { label: 'Yes', value: 'Yes' },
      { label: 'No', value: 'No' },
    ],
  };

  it('reads the questionnaire and flows to REVIEW when a session is present', async () => {
    const { db, task, eventRows } = createFakeTaskDb({
      state: 'QUEUED',
      platform: 'workday',
    });
    workdayState.session = { tenant: 'acme-wd', cookie: 'x', csrfToken: 'y' };
    workdayState.questionnaireId = 'Q-123';
    workdayState.fields = [workdayQuestion];
    // The read questions resolve fully (bank/profile), so nothing is missing.
    answersState.result = { resolved: [workdayQuestion], missing: [] };

    const outcome = await processTask(createDeps(db, { storage }), 'task-1');

    // The questionnaire was read with the posting's id...
    expect(workdayState.getQuestionnaireCalls).toEqual(['Q-123']);
    // ...its fields became the task's questions, and the spec is no longer
    // account-required — it flows through the SAME spine to REVIEW.
    const spec = task.jobSpec as { questions: unknown[]; formAccess: string };
    expect(spec.questions).toEqual([workdayQuestion]);
    expect(spec.formAccess).toBe('public');
    expect(outcome).toMatchObject({ kind: 'processed', state: 'REVIEW' });
    expect(task.state).toBe('REVIEW');
    // Not parked: no account-required note.
    expect((task.resolution as { note?: string }).note).toBeUndefined();
    expect(eventRows.map((e) => e.type)).toContain('RESOLVED_ALL');
  });

  it('reads the questionnaire but parks NEEDS_INPUT when a required answer is missing', async () => {
    const { db, task } = createFakeTaskDb({
      state: 'QUEUED',
      platform: 'workday',
    });
    workdayState.session = { tenant: 'acme-wd', cookie: 'x', csrfToken: 'y' };
    workdayState.questionnaireId = 'Q-123';
    workdayState.fields = [workdayQuestion];
    // A required question the bank/profile can't answer -> genuine NEEDS_INPUT.
    answersState.result = { resolved: [], missing: [workdayQuestion] };

    const outcome = await processTask(createDeps(db, { storage }), 'task-1');

    expect(workdayState.getQuestionnaireCalls).toEqual(['Q-123']);
    expect(outcome).toMatchObject({ kind: 'processed', state: 'NEEDS_INPUT' });
    // Parked because a real question is unanswered — NOT the account-required
    // park, so no Workday note (the dashboard shows the actual missing field).
    expect((task.resolution as { note?: string }).note).toBeUndefined();
  });

  it('parks account-required (never reads) when no session is captured', async () => {
    const { db, task } = createFakeTaskDb({
      state: 'QUEUED',
      platform: 'workday',
    });
    workdayState.session = null; // nothing in the vault for this tenant
    workdayState.questionnaireId = 'Q-123';

    const outcome = await processTask(createDeps(db, { storage }), 'task-1');

    // No read attempted; the spec stays account-required and parks with the
    // "capture a session" note surfaced to the human.
    expect(workdayState.getQuestionnaireCalls).toEqual([]);
    expect(outcome).toMatchObject({ kind: 'processed', state: 'NEEDS_INPUT' });
    const spec = task.jobSpec as { questions: unknown[]; formAccess: string };
    expect(spec.questions).toEqual([]);
    expect(spec.formAccess).toBe('account-required');
    expect((task.resolution as { note?: string }).note).toMatch(/Workday/);
  });

  it('parks gracefully when the read fails (expired session), never fails the task', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { db, task } = createFakeTaskDb({
      state: 'QUEUED',
      platform: 'workday',
    });
    workdayState.session = { tenant: 'acme-wd', cookie: 'x', csrfToken: 'y' };
    workdayState.questionnaireId = 'Q-123';
    workdayState.readError = 'workday session expired (401)';

    const outcome = await processTask(createDeps(db, { storage }), 'task-1');

    expect(workdayState.getQuestionnaireCalls).toEqual(['Q-123']);
    // A dead session must not FAIL the task — it parks account-required.
    expect(outcome).toMatchObject({ kind: 'processed', state: 'NEEDS_INPUT' });
    const spec = task.jobSpec as { questions: unknown[]; formAccess: string };
    expect(spec.formAccess).toBe('account-required');
    expect((task.resolution as { note?: string }).note).toMatch(/Workday/);
    warn.mockRestore();
  });

  it('does not read when the posting advertises no questionnaireId', async () => {
    const { db, task } = createFakeTaskDb({
      state: 'QUEUED',
      platform: 'workday',
    });
    workdayState.session = { tenant: 'acme-wd', cookie: 'x', csrfToken: 'y' };
    workdayState.questionnaireId = null; // posting has no questionnaire

    const outcome = await processTask(createDeps(db, { storage }), 'task-1');

    expect(workdayState.getQuestionnaireCalls).toEqual([]);
    expect(outcome).toMatchObject({ kind: 'processed', state: 'NEEDS_INPUT' });
    expect((task.resolution as { note?: string }).note).toMatch(/Workday/);
  });

  it('does not read when no storage (vault) dep is configured', async () => {
    const { db, task } = createFakeTaskDb({
      state: 'QUEUED',
      platform: 'workday',
    });
    workdayState.session = { tenant: 'acme-wd', cookie: 'x', csrfToken: 'y' };
    workdayState.questionnaireId = 'Q-123';

    // createDeps WITHOUT storage -> the pipeline can't load a session.
    const outcome = await processTask(createDeps(db), 'task-1');

    expect(workdayState.getQuestionnaireCalls).toEqual([]);
    expect(outcome).toMatchObject({ kind: 'processed', state: 'NEEDS_INPUT' });
    expect((task.resolution as { note?: string }).note).toMatch(/Workday/);
  });
});

describe('processTask company-scoped answer bank (Contract C)', () => {
  it("passes the job's normalized companyKey as opts.company", async () => {
    // The ingest-recorded company is authoritative and gets normalized
    // (lowercase + trim) into the companyKey resolveAnswers matches on.
    const { db } = createFakeTaskDb({
      state: 'QUEUED',
      company: '  Acme Corp ',
    });

    await processTask(createDeps(db), 'task-1');

    expect((answersState.lastOpts as { company?: string }).company).toBe(
      'acme corp',
    );
  });

  it('falls back to the discovered spec company when the job has none', async () => {
    // Raw-URL ingest: jobs.company is null; the adapter discovers the company.
    const { db } = createFakeTaskDb({ state: 'QUEUED', company: null });
    adapterState.company = 'Globex';

    await processTask(createDeps(db), 'task-1');

    expect((answersState.lastOpts as { company?: string }).company).toBe(
      'globex',
    );
  });

  it('passes each bank row through with its company scope intact', async () => {
    const { db } = createFakeTaskDb({
      state: 'QUEUED',
      company: 'Acme',
      bank: [
        {
          normalizedLabel: 'why do you want to work here',
          value: 'Because Acme builds anvils.',
          company: 'acme',
        },
        {
          normalizedLabel: 'why do you want to work here',
          value: 'Because Globex is global.',
          company: 'globex',
        },
        { normalizedLabel: 'pronouns', value: 'they/them', company: '' },
      ],
    });

    await processTask(createDeps(db), 'task-1');

    // Every row — including the OTHER company's — reaches resolveAnswers with
    // its scope attached; the isolation decision (only 'acme' or global may
    // resolve for this job) belongs to @sower/answers and is tested there.
    expect(answersState.lastOpts).toEqual({
      bank: [
        {
          normalizedLabel: 'why do you want to work here',
          value: 'Because Acme builds anvils.',
          company: 'acme',
        },
        {
          normalizedLabel: 'why do you want to work here',
          value: 'Because Globex is global.',
          company: 'globex',
        },
        { normalizedLabel: 'pronouns', value: 'they/them', company: '' },
      ],
      documents: [],
      company: 'acme',
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

describe('processTask #ingest reply refresh (post-parse label upgrade)', () => {
  it('refreshes the ingest reply after a successful parse that lands in REVIEW', async () => {
    const { db } = createFakeTaskDb({ state: 'QUEUED' });
    answersState.result = {
      resolved: [{ questionId: 'email', source: 'profile', value: 'x' }],
      missing: [],
    };
    const deps = createDeps(db);

    const outcome = await processTask(deps, 'task-1');

    expect(outcome).toMatchObject({ kind: 'processed', state: 'REVIEW' });
    expect(refreshIngestReply).toHaveBeenCalledTimes(1);
    expect(refreshIngestReply).toHaveBeenCalledWith(deps, 'task-1');
  });

  it('refreshes after a parse that parks in NEEDS_INPUT too (still a successful parse)', async () => {
    const { db } = createFakeTaskDb({ state: 'QUEUED' });
    answersState.result = {
      resolved: [],
      missing: [
        { id: 'resume', label: 'Resume', type: 'file', required: true },
      ],
    };

    const outcome = await processTask(createDeps(db), 'task-1');

    expect(outcome).toMatchObject({ kind: 'processed', state: 'NEEDS_INPUT' });
    expect(refreshIngestReply).toHaveBeenCalledTimes(1);
  });

  it('does not refresh when the parse fails', async () => {
    const { db } = createFakeTaskDb({ state: 'QUEUED' });
    adapterState.discoverError = 'boom';

    const outcome = await processTask(createDeps(db), 'task-1');

    expect(outcome).toMatchObject({ kind: 'failed' });
    expect(refreshIngestReply).not.toHaveBeenCalled();
  });

  it('never fails processing when the refresh itself rejects (best-effort)', async () => {
    const { db, task } = createFakeTaskDb({ state: 'QUEUED' });
    vi.mocked(refreshIngestReply).mockRejectedValueOnce(
      new Error('discord down'),
    );

    const outcome = await processTask(createDeps(db), 'task-1');

    expect(outcome).toMatchObject({ kind: 'processed', state: 'REVIEW' });
    expect(task.lastError).toBeNull();
  });
});

describe('processTask Contract D (company/title backfill)', () => {
  it('backfills blank company & title from the discovered spec', async () => {
    // Raw-URL ingest: the jobs row has no company/title. Discover surfaces both.
    const { db, job } = createFakeTaskDb({
      state: 'QUEUED',
      company: null,
      title: null,
    });
    adapterState.company = 'Acme Corp';
    adapterState.title = 'Backend Engineer';

    const outcome = await processTask(createDeps(db), 'task-1');

    expect(outcome.kind).toBe('processed');
    expect(job.company).toBe('Acme Corp');
    expect(job.title).toBe('Backend Engineer');
  });

  it('never overwrites a company/title the ingest already recorded', async () => {
    const { db, job } = createFakeTaskDb({
      state: 'QUEUED',
      company: 'Ingest Co',
      title: 'Ingest Title',
    });
    adapterState.company = 'Discovered Co';
    adapterState.title = 'Discovered Title';

    await processTask(createDeps(db), 'task-1');

    expect(job.company).toBe('Ingest Co');
    expect(job.title).toBe('Ingest Title');
  });

  it('leaves company null when the spec has no company (fills only blanks)', async () => {
    const { db, job } = createFakeTaskDb({
      state: 'QUEUED',
      company: null,
      title: null,
    });
    // No adapterState.company set: spec carries no company (e.g. Ashby without
    // an org display name would fall back to tenant in the adapter, but here we
    // model an adapter that surfaces none).
    adapterState.title = 'Only A Title';

    await processTask(createDeps(db), 'task-1');

    expect(job.company).toBeNull();
    expect(job.title).toBe('Only A Title');
  });
});

describe('processTask Contract D (description versioning)', () => {
  const DESC = 'We are hiring a backend engineer to build our platform.';

  it('inserts version 1 the first time a description is discovered', async () => {
    const { db, descriptionRows } = createFakeTaskDb({ state: 'QUEUED' });
    adapterState.description = DESC;

    await processTask(createDeps(db), 'task-1');

    expect(descriptionRows).toHaveLength(1);
    expect(descriptionRows[0]).toEqual({
      jobId: 'job-1',
      version: 1,
      content: DESC,
      contentHash: sha256Hex(DESC),
    });
  });

  it('stores nothing on re-discover when the description is unchanged', async () => {
    const descriptionRows: FakeDescriptionRow[] = [
      {
        jobId: 'job-1',
        version: 1,
        content: DESC,
        contentHash: sha256Hex(DESC),
      },
    ];
    const { db } = createFakeTaskDb({
      state: 'QUEUED',
      descriptions: descriptionRows,
    });
    adapterState.description = DESC;

    await processTask(createDeps(db), 'task-1');

    // Same content_hash as the latest row: no new version is written.
    expect(descriptionRows).toHaveLength(1);
  });

  it('inserts version 2 when a re-discover changes the description', async () => {
    const descriptionRows: FakeDescriptionRow[] = [
      {
        jobId: 'job-1',
        version: 1,
        content: DESC,
        contentHash: sha256Hex(DESC),
      },
    ];
    const { db } = createFakeTaskDb({
      state: 'QUEUED',
      descriptions: descriptionRows,
    });
    const NEXT = `${DESC} Updated with new responsibilities.`;
    adapterState.description = NEXT;

    await processTask(createDeps(db), 'task-1');

    expect(descriptionRows).toHaveLength(2);
    expect(descriptionRows[1]).toEqual({
      jobId: 'job-1',
      version: 2,
      content: NEXT,
      contentHash: sha256Hex(NEXT),
    });
  });

  it('stores nothing when the spec carries no description', async () => {
    const { db, descriptionRows } = createFakeTaskDb({ state: 'QUEUED' });
    // adapterState.description left undefined.

    await processTask(createDeps(db), 'task-1');

    expect(descriptionRows).toHaveLength(0);
  });
});

describe('processTask deadline persistence (jobs.deadline)', () => {
  it("writes the spec's explicit ATS deadline onto a deadline-less jobs row", async () => {
    const { db, job } = createFakeTaskDb({ state: 'QUEUED' });
    adapterState.deadline = '2026-08-01T00:00:00.000Z';

    const outcome = await processTask(createDeps(db), 'task-1');

    expect(outcome.kind).toBe('processed');
    expect(job.deadline).toEqual(new Date('2026-08-01T00:00:00.000Z'));
    // A NEW posting deadline is the tasks' effective deadline — the job-wide
    // calendar sync runs (proven in calendar-sync.test.ts, mocked here).
    expect(calendarSyncState.jobCalls).toEqual([job.id]);
  });

  it('parses an explicit "apply by <date>" out of the JD text when the spec has no field', async () => {
    const { db, job } = createFakeTaskDb({ state: 'QUEUED' });
    adapterState.description =
      'Join us! Applications close on March 1, 2027. Benefits: snacks.';

    await processTask(createDeps(db), 'task-1');

    expect(job.deadline).toEqual(new Date('2027-03-01T00:00:00.000Z'));
  });

  it('prefers the explicit spec field over the JD text', async () => {
    const { db, job } = createFakeTaskDb({ state: 'QUEUED' });
    adapterState.deadline = '2026-08-01';
    adapterState.description = 'Apply by January 9, 2027.';

    await processTask(createDeps(db), 'task-1');

    // Date-only ATS values normalize to ET midnight (EDT: 04:00Z).
    expect(job.deadline).toEqual(new Date('2026-08-01T04:00:00.000Z'));
  });

  it('never overwrites a deadline the jobs row already has', async () => {
    const recorded = new Date('2026-06-15T00:00:00.000Z');
    const { db, job } = createFakeTaskDb({
      state: 'QUEUED',
      deadline: recorded,
    });
    adapterState.deadline = '2026-08-01T00:00:00.000Z';

    await processTask(createDeps(db), 'task-1');

    expect(job.deadline).toBe(recorded);
    // No deadline change ⇒ no calendar churn.
    expect(calendarSyncState.jobCalls).toEqual([]);
  });

  it('writes nothing when neither the spec nor the JD names a deadline', async () => {
    const { db, job } = createFakeTaskDb({ state: 'QUEUED' });
    adapterState.description = 'A great role with no stated deadline.';

    await processTask(createDeps(db), 'task-1');

    expect(job.deadline).toBeNull();
  });

  it('ignores an unparseable spec deadline instead of guessing', async () => {
    const { db, job } = createFakeTaskDb({ state: 'QUEUED' });
    adapterState.deadline = 'until filled';

    await processTask(createDeps(db), 'task-1');

    expect(job.deadline).toBeNull();
  });
});

describe('processTask full-time auto-discard', () => {
  it('discards a full-time posting with reason auto and the employment type in the note', async () => {
    const { db, task, eventRows } = createFakeTaskDb({ state: 'QUEUED' });
    adapterState.title = 'Staff Software Engineer';
    adapterState.employmentType = 'Full time';
    adapterState.description = 'A full-time role.';

    const outcome = await processTask(createDeps(db), 'task-1');

    expect(outcome).toEqual({
      kind: 'auto_discarded',
      state: 'DISCARDED',
      employmentType: 'Full time',
    });
    expect(task.state).toBe('DISCARDED');
    expect(eventRows.map((e) => [e.type, e.fromState, e.toState])).toEqual([
      ['PROCESS_START', 'QUEUED', 'PREPARING'],
      ['DISCARD', 'PREPARING', 'DISCARDED'],
    ]);
    // The DISCARD event's data is what the dashboard labels "Auto discarded"
    // from: data.reason === 'auto', with the human-readable why in the note.
    expect(eventRows.at(-1)?.data).toEqual({
      reason: 'auto',
      note: 'Employment type: Full time',
    });
    // Processing stopped BEFORE resolution: no answers were resolved and no
    // RESOLVED_* event exists — the task never reached REVIEW/NEEDS_INPUT.
    expect(answersState.lastOpts).toBeUndefined();
    // The #ingest reply line flips to "discarded".
    expect(refreshIngestReply).toHaveBeenCalledTimes(1);
    expect(refreshIngestReply).toHaveBeenCalledWith(
      expect.anything(),
      'task-1',
    );
  });

  it.each([
    'Full-Time',
    'FULL TIME',
    'FullTime',
    'full-time',
  ])('discards the %s casing/hyphen variant', async (employmentType) => {
    const { db, task } = createFakeTaskDb({ state: 'QUEUED' });
    adapterState.title = 'Backend Engineer';
    adapterState.employmentType = employmentType;

    const outcome = await processTask(createDeps(db), 'task-1');

    expect(outcome).toEqual({
      kind: 'auto_discarded',
      state: 'DISCARDED',
      employmentType,
    });
    expect(task.state).toBe('DISCARDED');
  });

  it('proceeds normally for an Intern employment type', async () => {
    const { db, task } = createFakeTaskDb({ state: 'QUEUED' });
    adapterState.title = 'Backend Engineer';
    adapterState.employmentType = 'Intern';

    const outcome = await processTask(createDeps(db), 'task-1');

    expect(outcome).toMatchObject({ kind: 'processed', state: 'REVIEW' });
    expect(task.state).toBe('REVIEW');
  });

  it('proceeds when the spec title says intern despite a full-time label (mislabel safety)', async () => {
    const { db, task } = createFakeTaskDb({ state: 'QUEUED' });
    adapterState.title = 'Software Engineer Intern';
    adapterState.employmentType = 'Full time';

    const outcome = await processTask(createDeps(db), 'task-1');

    expect(outcome).toMatchObject({ kind: 'processed', state: 'REVIEW' });
    expect(task.state).toBe('REVIEW');
  });

  it('proceeds when the ingest-recorded job title says intern despite a full-time label', async () => {
    const { db, task } = createFakeTaskDb({
      state: 'QUEUED',
      title: 'SWE Internship (Summer 2027)',
    });
    adapterState.title = 'Backend Engineer';
    adapterState.employmentType = 'Full time';

    const outcome = await processTask(createDeps(db), 'task-1');

    expect(outcome).toMatchObject({ kind: 'processed', state: 'REVIEW' });
    expect(task.state).toBe('REVIEW');
  });

  it('proceeds when the employment type itself also says intern', async () => {
    const { db } = createFakeTaskDb({ state: 'QUEUED' });
    adapterState.title = 'Backend Engineer';
    adapterState.employmentType = 'Full time (Internship program)';

    const outcome = await processTask(createDeps(db), 'task-1');

    expect(outcome).toMatchObject({ kind: 'processed', state: 'REVIEW' });
  });

  it('never re-discards a task a human restored (RESTORE event guard)', async () => {
    const { db, task, eventRows } = createFakeTaskDb({
      state: 'QUEUED',
      events: [
        {
          taskId: 'task-1',
          type: 'DISCARD',
          fromState: 'PREPARING',
          toState: 'DISCARDED',
          data: { reason: 'auto', note: 'Employment type: Full time' },
        },
        {
          taskId: 'task-1',
          type: 'RESTORE',
          fromState: 'DISCARDED',
          toState: 'NEEDS_INPUT',
          data: { reason: 'manual' },
        },
        {
          taskId: 'task-1',
          type: 'RETRY',
          fromState: 'NEEDS_INPUT',
          toState: 'QUEUED',
          data: null,
        },
      ],
    });
    adapterState.title = 'Staff Software Engineer';
    adapterState.employmentType = 'Full time';

    const outcome = await processTask(createDeps(db), 'task-1');

    // The human's restore overrides the rule: the task processes normally.
    expect(outcome).toMatchObject({ kind: 'processed', state: 'REVIEW' });
    expect(task.state).toBe('REVIEW');
    expect(eventRows.filter((e) => e.type === 'DISCARD')).toHaveLength(1);
  });

  it('still persists the spec, backfill, and description before discarding', async () => {
    const { db, task, job, descriptionRows } = createFakeTaskDb({
      state: 'QUEUED',
      company: null,
      title: null,
    });
    adapterState.title = 'Staff Software Engineer';
    adapterState.company = 'Acme Corp';
    adapterState.employmentType = 'Full time';
    adapterState.description = 'Full-time role description.';

    await processTask(createDeps(db), 'task-1');

    // Even a discarded task keeps its parsed record: the Archive row shows
    // the real title/company and the JD is versioned for later reference.
    expect(task.jobSpec).toMatchObject({ employmentType: 'Full time' });
    expect(job.company).toBe('Acme Corp');
    expect(job.title).toBe('Staff Software Engineer');
    expect(descriptionRows).toHaveLength(1);
  });
});

describe('processTask greenhouse tenant self-heal (custom domain)', () => {
  const CUSTOM_URL =
    'https://akunacapital.com/careers/job/8018853/swe?gh_jid=8018853';
  const BOARD_URL =
    'https://job-boards.greenhouse.io/akunacapital/jobs/8018853';

  function tenantlessDb(overrides: { collidingJobId?: string } = {}) {
    return createFakeTaskDb({
      state: 'QUEUED',
      tenant: null,
      url: CUSTOM_URL,
      externalId: '8018853',
      ...overrides,
    });
  }

  it('adopts a probe-verified tenant + the canonical board URL, then discovery proceeds', async () => {
    const { db, task, job } = tenantlessDb();
    probeState.tenant = 'akunacapital';
    answersState.result = {
      resolved: [{ questionId: 'email', source: 'profile', value: 'x' }],
      missing: [],
    };

    const outcome = await processTask(createDeps(db), 'task-1');

    // Probed with the job's stored (custom-domain) URL + external id.
    expect(probeState.calls).toEqual([{ url: CUSTOM_URL, jobId: '8018853' }]);
    // The jobs row was healed: tenant + board url/canonical/dedupe key.
    expect(job.tenant).toBe('akunacapital');
    expect(job.url).toBe(BOARD_URL);
    expect(job.canonicalUrl).toBe(BOARD_URL);
    expect(job.dedupeKey).toBe('greenhouse:akunacapital:8018853');
    // Discovery ran WITH the verified tenant and the task flowed to REVIEW.
    expect(adapterState.lastDiscoverRef).toMatchObject({
      tenant: 'akunacapital',
      externalId: '8018853',
    });
    expect(outcome).toMatchObject({ kind: 'processed', state: 'REVIEW' });
    expect(task.state).toBe('REVIEW');
  });

  it('keeps the custom-domain url when the canonical board identity collides with another job', async () => {
    // A board-hosted paste of the same posting already owns the canonical
    // URL / dedupe key (both UNIQUE): only the tenant may be adopted.
    const { db, job } = tenantlessDb({ collidingJobId: 'job-2' });
    probeState.tenant = 'akunacapital';

    const outcome = await processTask(createDeps(db), 'task-1');

    expect(job.tenant).toBe('akunacapital');
    expect(job.url).toBe(CUSTOM_URL);
    expect(job.canonicalUrl).toBe(CUSTOM_URL);
    expect(job.dedupeKey).toBe(CUSTOM_URL);
    // Discovery still proceeds — the adapter reads tenant+id, not the URL.
    expect(adapterState.lastDiscoverRef).toMatchObject({
      tenant: 'akunacapital',
    });
    expect(outcome).toMatchObject({ kind: 'processed', state: 'REVIEW' });
  });

  it('re-parks with the SAME reason (never FAIL) when the probe verifies nothing', async () => {
    const { db, task, job, eventRows } = tenantlessDb();
    // probeState.tenant stays null: no candidate verified.

    const outcome = await processTask(createDeps(db), 'task-1');

    // The existing parked outcome: a clean NEEDS_INPUT, not a retry loop.
    expect(outcome).toEqual({
      kind: 'processed',
      state: 'NEEDS_INPUT',
      resolved: 0,
      missing: 0,
    });
    expect(task.state).toBe('NEEDS_INPUT');
    expect(task.lastError).toBeNull();
    expect(eventRows.map((e) => [e.type, e.fromState, e.toState])).toEqual([
      ['PROCESS_START', 'QUEUED', 'PREPARING'],
      ['RESOLVED_PARTIAL', 'PREPARING', 'NEEDS_INPUT'],
    ]);
    expect(eventRows.at(-1)?.data).toEqual({
      reason: 'greenhouse job without tenant (custom domain)',
    });
    // The parked resolution explains WHY (surfaced on the dashboard)...
    expect((task.resolution as { note?: string }).note).toMatch(/tenant/);
    // ...and discovery was never attempted (it would have thrown).
    expect(adapterState.lastDiscoverRef).toBeUndefined();
    // The jobs row is untouched — a later requeue probes again.
    expect(job.tenant).toBeNull();
    expect(job.url).toBe(CUSTOM_URL);
  });

  it('never probes a greenhouse job that already has a tenant', async () => {
    const { db } = createFakeTaskDb({ state: 'QUEUED' });

    const outcome = await processTask(createDeps(db), 'task-1');

    expect(outcome).toMatchObject({ kind: 'processed' });
    expect(probeState.calls).toEqual([]);
  });
});

describe('processTask unknown-platform self-heal (trailing numeric id)', () => {
  // The live databricks shape: no gh_jid, no board host — the only greenhouse
  // evidence is the numeric job id at the tail of the URL path.
  const SLUG_URL =
    'https://www.databricks.com/company/careers/university-recruiting/swe-intern-2027-7011263002';
  const BOARD_URL =
    'https://job-boards.greenhouse.io/databricks/jobs/7011263002';

  function unknownDb(
    overrides: { collidingJobId?: string; url?: string } = {},
  ) {
    return createFakeTaskDb({
      state: 'QUEUED',
      platform: 'unknown',
      tenant: null,
      externalId: null,
      url: SLUG_URL,
      ...overrides,
    });
  }

  it('probe hit adopts the greenhouse identity + canonical URL, then processes normally', async () => {
    const { db, task, job } = unknownDb();
    probeState.tenant = 'databricks';
    answersState.result = {
      resolved: [{ questionId: 'email', source: 'profile', value: 'x' }],
      missing: [],
    };

    const outcome = await processTask(createDeps(db), 'task-1');

    // Probed with the stored URL + the id extracted from its tail.
    expect(probeState.calls).toEqual([{ url: SLUG_URL, jobId: '7011263002' }]);
    // The jobs row was healed into a first-class greenhouse job.
    expect(job.platform).toBe('greenhouse');
    expect(job.tenant).toBe('databricks');
    expect(job.externalId).toBe('7011263002');
    expect(job.url).toBe(BOARD_URL);
    expect(job.canonicalUrl).toBe(BOARD_URL);
    expect(job.dedupeKey).toBe('greenhouse:databricks:7011263002');
    // Discovery ran with the adopted identity and the task flowed to REVIEW.
    expect(adapterState.lastDiscoverRef).toMatchObject({
      tenant: 'databricks',
      externalId: '7011263002',
    });
    expect(outcome).toMatchObject({ kind: 'processed', state: 'REVIEW' });
    expect(task.state).toBe('REVIEW');
  });

  it('keeps the custom-domain url when the canonical identity collides with another job', async () => {
    const { db, job } = unknownDb({ collidingJobId: 'job-2' });
    probeState.tenant = 'databricks';

    const outcome = await processTask(createDeps(db), 'task-1');

    // Identity adopted; URL/dedupe key untouched (both UNIQUE, already owned).
    expect(job.platform).toBe('greenhouse');
    expect(job.tenant).toBe('databricks');
    expect(job.externalId).toBe('7011263002');
    expect(job.url).toBe(SLUG_URL);
    expect(job.canonicalUrl).toBe(SLUG_URL);
    expect(outcome).toMatchObject({ kind: 'processed', state: 'REVIEW' });
  });

  it('probe miss falls through unchanged (the unknown-platform failure, job untouched)', async () => {
    const { db, task, job } = unknownDb();
    // probeState.tenant stays null: the candidate id verified nowhere.

    const outcome = await processTask(createDeps(db), 'task-1');

    expect(probeState.calls).toEqual([{ url: SLUG_URL, jobId: '7011263002' }]);
    // Exactly the pre-fix outcome for a requeued unknown task.
    expect(outcome).toMatchObject({
      kind: 'failed',
      error: "no adapter for platform 'unknown'",
    });
    expect(task.state).toBe('FAILED');
    expect(job.platform).toBe('unknown');
    expect(job.url).toBe(SLUG_URL);
  });

  it('never probes an unknown job whose URL carries no trailing numeric id', async () => {
    const { db } = unknownDb({
      url: 'https://weirdats.example/careers/senior-baker',
    });

    const outcome = await processTask(createDeps(db), 'task-1');

    expect(probeState.calls).toEqual([]);
    expect(outcome).toMatchObject({ kind: 'failed' });
  });
});

describe('processTask clears lastError on a successful pass', () => {
  const STALE = 'ENOENT: no such file or directory';

  it('clears a stale lastError when the pass resolves to REVIEW', async () => {
    const { db, task } = createFakeTaskDb({
      state: 'FAILED',
      attempt: 1,
      lastError: STALE,
    });
    answersState.result = {
      resolved: [{ questionId: 'email', source: 'profile', value: 'x' }],
      missing: [],
    };

    const outcome = await processTask(createDeps(db), 'task-1');

    expect(outcome).toMatchObject({ kind: 'processed', state: 'REVIEW' });
    // The stale error from the earlier attempt is gone (live case: Aquatic
    // processed fine but the dashboard kept showing the old ENOENT).
    expect(task.lastError).toBeNull();
  });

  it('clears a stale lastError when the pass parks in NEEDS_INPUT', async () => {
    const { db, task } = createFakeTaskDb({
      state: 'FAILED',
      attempt: 1,
      lastError: STALE,
    });
    answersState.result = {
      resolved: [],
      missing: [
        { id: 'resume', label: 'Resume', type: 'file', required: true },
      ],
    };

    const outcome = await processTask(createDeps(db), 'task-1');

    expect(outcome).toMatchObject({ kind: 'processed', state: 'NEEDS_INPUT' });
    expect(task.lastError).toBeNull();
  });

  it('clears a stale lastError on auto-discard', async () => {
    const { db, task } = createFakeTaskDb({
      state: 'QUEUED',
      lastError: STALE,
    });
    adapterState.title = 'Staff Software Engineer';
    adapterState.employmentType = 'Full time';

    const outcome = await processTask(createDeps(db), 'task-1');

    expect(outcome).toMatchObject({ kind: 'auto_discarded' });
    expect(task.lastError).toBeNull();
  });

  it('clears a stale lastError on the tenant-less greenhouse re-park', async () => {
    const { db, task } = createFakeTaskDb({
      state: 'QUEUED',
      tenant: null,
      url: 'https://akunacapital.com/careers/job/8018853/swe?gh_jid=8018853',
      externalId: '8018853',
      lastError: STALE,
    });
    // probeState.tenant stays null: the task re-parks — still a completed pass.

    const outcome = await processTask(createDeps(db), 'task-1');

    expect(outcome).toMatchObject({ kind: 'processed', state: 'NEEDS_INPUT' });
    expect(task.lastError).toBeNull();
  });

  it('a failing pass still overwrites lastError with the fresh error', async () => {
    const { db, task } = createFakeTaskDb({
      state: 'FAILED',
      attempt: 1,
      lastError: STALE,
    });
    adapterState.discoverError = 'boom';

    const outcome = await processTask(createDeps(db), 'task-1');

    expect(outcome).toMatchObject({ kind: 'failed', error: 'boom' });
    expect(task.lastError).toBe('boom');
  });
});
