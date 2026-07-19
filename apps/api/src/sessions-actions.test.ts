import {
  accounts,
  agentHeartbeats,
  applicationTasks,
  workdaySessions,
} from '@sower/db';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from './config.js';
import {
  claimSessionRequest,
  completeSessionCapture,
  failSessionCapture,
  recordAgentHeartbeat,
  startSessionCapture,
} from './sessions-actions.js';
import type { Deps } from './types.js';

const accountState = vi.hoisted(() => ({
  ensured: [] as unknown[],
  credential: null as { email: string; password: string } | null,
  statusSet: [] as { tenant: string; status: string }[],
}));

vi.mock('@sower/accounts', () => ({
  AccountManager: class {
    async ensureAccount(input: unknown) {
      accountState.ensured.push(input);
      return {
        account: {},
        credential: accountState.credential,
        created: true,
      };
    }
    async getCredential(_platform: string, _tenant: string) {
      return accountState.credential;
    }
    async setStatus(_platform: string, tenant: string, status: string) {
      accountState.statusSet.push({ tenant, status });
    }
  },
}));

const profileState = vi.hoisted(() => ({
  profile: { email: 'ada@example.com' } as { email: string },
}));

vi.mock('@sower/answers', () => ({
  getProfile: async () => profileState.profile,
  // The real isEmptyProfile also checks name/phone; the fake keys off the
  // email — the one field startSessionCapture actually needs.
  isEmptyProfile: (profile: { email?: string }) => (profile.email ?? '') === '',
}));

const savedSessions = vi.hoisted(() => ({ list: [] as unknown[] }));
vi.mock('@sower/platforms', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@sower/platforms')>()),
  saveWorkdaySession: vi.fn(async (_vault: unknown, session: unknown) => {
    savedSessions.list.push(session);
  }),
}));

const requeueState = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock('./task-actions.js', () => ({
  requeueTask: vi.fn(async (_deps: unknown, taskId: string) => {
    requeueState.calls.push(taskId);
    return { kind: 'requeued', state: 'QUEUED' };
  }),
}));

/** A table-dispatching fake db that records writes and serves configured reads. */
function makeDb(opts: {
  taskJoin?: unknown[];
  parked?: { id: string }[];
  claimRow?: Record<string, unknown> | null;
}) {
  const inserts: { table: unknown; values: unknown }[] = [];
  const updates: { table: unknown; set: Record<string, unknown> }[] = [];
  const db = {
    select: (fields?: Record<string, unknown>) => {
      const isTaskJoin = fields !== undefined && 'task' in fields;
      const result = isTaskJoin ? (opts.taskJoin ?? []) : (opts.parked ?? []);
      const chain = {
        from: () => chain,
        innerJoin: () => chain,
        where: () => chain,
        limit: () => chain,
        // biome-ignore lint/suspicious/noThenProperty: mimics drizzle's awaitable builder
        then: (onFulfilled: (v: unknown) => unknown) =>
          Promise.resolve(result).then(onFulfilled),
      };
      return chain;
    },
    insert: (table: unknown) => ({
      values: (values: unknown) => ({
        onConflictDoUpdate: async () => {
          inserts.push({ table, values });
          return [];
        },
      }),
    }),
    update: (table: unknown) => ({
      set: (set: Record<string, unknown>) => ({
        where: () => {
          updates.push({ table, set });
          return {
            returning: async () => (opts.claimRow ? [opts.claimRow] : []),
            // biome-ignore lint/suspicious/noThenProperty: mimics drizzle's awaitable builder
            then: (onFulfilled: (v: unknown) => unknown) =>
              Promise.resolve([]).then(onFulfilled),
          };
        },
      }),
    }),
  };
  return { db: db as unknown as Deps['db'], inserts, updates };
}

const config = { PROFILE_PATH: './config/profile.sample.yaml' } as Config;
const storage = {} as NonNullable<Deps['storage']>;

beforeEach(() => {
  accountState.ensured = [];
  accountState.credential = { email: 'ada@example.com', password: 'pw-1' };
  accountState.statusSet = [];
  savedSessions.list = [];
  requeueState.calls = [];
  profileState.profile = { email: 'ada@example.com' };
});

describe('startSessionCapture', () => {
  const workdayTaskJoin = [
    {
      task: {
        id: 'task-1',
        jobSpec: {
          platform: 'workday',
          tenant: 'caci',
          applyUrl: 'https://caci.wd1.myworkdayjobs.com/external/job/x/SWE_1',
          meta: { site: 'external' },
        },
      },
      job: {
        platform: 'workday',
        tenant: 'caci',
        url: 'https://caci.wd1.myworkdayjobs.com/x',
      },
    },
  ];

  it('requests a capture and provisions the account for a Workday task', async () => {
    const { db, inserts } = makeDb({ taskJoin: workdayTaskJoin });
    const outcome = await startSessionCapture(
      { db, storage, config } as Deps,
      'task-1',
    );

    expect(outcome).toEqual({
      kind: 'started',
      tenant: 'caci',
      status: 'requested',
    });
    // Account provisioned with the profile email (matches the application email).
    expect(accountState.ensured).toEqual([
      {
        platform: 'workday',
        tenant: 'caci',
        site: 'external',
        email: 'ada@example.com',
      },
    ]);
    // workday_sessions upserted to 'requested' with the derived host.
    const req = inserts.find((i) => i.table === workdaySessions);
    expect(req?.values).toMatchObject({
      tenant: 'caci',
      host: 'caci.wd1.myworkdayjobs.com',
      status: 'requested',
    });
  });

  it('is a no-op for non-Workday tasks', async () => {
    const { db } = makeDb({
      taskJoin: [
        { task: { id: 't', jobSpec: {} }, job: { platform: 'greenhouse' } },
      ],
    });
    const outcome = await startSessionCapture(
      { db, storage, config } as Deps,
      't',
    );
    expect(outcome).toEqual({ kind: 'unsupported', platform: 'greenhouse' });
    expect(accountState.ensured).toEqual([]);
  });

  it('reports no_storage when the vault is unconfigured', async () => {
    const { db } = makeDb({ taskJoin: workdayTaskJoin });
    const outcome = await startSessionCapture({ db, config } as Deps, 'task-1');
    expect(outcome).toEqual({ kind: 'no_storage' });
  });

  it('returns not_found for an unknown task', async () => {
    const { db } = makeDb({ taskJoin: [] });
    const outcome = await startSessionCapture(
      { db, storage, config } as Deps,
      'nope',
    );
    expect(outcome).toEqual({ kind: 'not_found' });
  });

  it('fails with an actionable error (no account provisioned) when no profile is configured', async () => {
    profileState.profile = { email: '' };
    const { db, inserts } = makeDb({ taskJoin: workdayTaskJoin });
    await expect(
      startSessionCapture({ db, storage, config } as Deps, 'task-1'),
    ).rejects.toThrowError(/no profile configured/);
    // Never provision an account with a blank email or request a capture.
    expect(accountState.ensured).toEqual([]);
    expect(inserts).toEqual([]);
  });
});

describe('claimSessionRequest', () => {
  it('returns the credential when a request is claimed', async () => {
    const { db } = makeDb({
      claimRow: {
        tenant: 'caci',
        host: 'caci.wd1.myworkdayjobs.com',
        loginUrl: 'https://caci.wd1.myworkdayjobs.com/x',
      },
    });
    const outcome = await claimSessionRequest({ db, storage } as Deps);
    expect(outcome).toEqual({
      kind: 'claimed',
      tenant: 'caci',
      host: 'caci.wd1.myworkdayjobs.com',
      loginUrl: 'https://caci.wd1.myworkdayjobs.com/x',
      email: 'ada@example.com',
      password: 'pw-1',
    });
  });

  it('is empty when nothing is pending', async () => {
    const { db } = makeDb({ claimRow: null });
    expect(await claimSessionRequest({ db, storage } as Deps)).toEqual({
      kind: 'empty',
    });
  });

  it('is empty when no vault storage is configured', async () => {
    const { db } = makeDb({ claimRow: { tenant: 'caci' } });
    expect(await claimSessionRequest({ db } as Deps)).toEqual({
      kind: 'empty',
    });
  });
});

describe('completeSessionCapture', () => {
  const session = {
    host: 'caci.wd1.myworkdayjobs.com',
    tenant: 'caci',
    cookie: 'PLAY_SESSION=x',
    csrfToken: 'csrf',
  };

  it('vaults the session, marks active, and re-enqueues parked tasks', async () => {
    const { db, updates } = makeDb({
      parked: [{ id: 'task-1' }, { id: 'task-2' }],
    });
    const result = await completeSessionCapture(
      { db, storage } as Deps,
      'caci',
      session,
    );

    expect(savedSessions.list).toEqual([session]);
    // workday_sessions marked active + account verified.
    const activeUpdate = updates.find((u) => u.table === workdaySessions);
    expect(activeUpdate?.set).toMatchObject({ status: 'active' });
    expect(accountState.statusSet).toEqual([
      { tenant: 'caci', status: 'verified' },
    ]);
    // Both parked Workday tasks re-enqueued.
    expect(requeueState.calls).toEqual(['task-1', 'task-2']);
    expect(result).toEqual({ requeued: 2 });
  });

  it('rejects a session whose tenant does not match the URL', async () => {
    const { db } = makeDb({});
    await expect(
      completeSessionCapture({ db, storage } as Deps, 'other', session),
    ).rejects.toThrow(/does not match/);
    expect(savedSessions.list).toEqual([]);
  });
});

describe('failSessionCapture + recordAgentHeartbeat', () => {
  it('marks the tenant failed with the error', async () => {
    const { db, updates } = makeDb({});
    await failSessionCapture({ db } as Deps, 'caci', 'verify failed');
    const u = updates.find((x) => x.table === workdaySessions);
    expect(u?.set).toMatchObject({ status: 'failed', error: 'verify failed' });
  });

  it('upserts the agent heartbeat', async () => {
    const { db, inserts } = makeDb({});
    await recordAgentHeartbeat({ db } as Deps, 'home-agent', 'idle');
    const hb = inserts.find((i) => i.table === agentHeartbeats);
    expect(hb?.values).toMatchObject({ name: 'home-agent', detail: 'idle' });
  });
});

// Keep the imported `accounts` + `applicationTasks` tables referenced so the
// table-identity dispatch above stays honest if a query is retargeted.
void accounts;
void applicationTasks;
