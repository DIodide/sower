import type { Profile } from '@sower/answers';
import type { ApplicationTask, Database } from '@sower/db';
import { answers, documents, jobs } from '@sower/db';
import type { Storage } from '@sower/storage';
import { describe, expect, it, vi } from 'vitest';
import { type FakeScreen, FakeWorkdayPage } from './fake-page.js';
import { createWorkdayWorker, type WorkdayPageSession } from './worker.js';

const profile = {
  email: 'ibraheem.amin2@gmail.com',
  name: { first: 'Ibraheem', last: 'Amin' },
  custom: {},
} as unknown as Profile;

/** Fake drizzle surface for the two/three selects the worker runs. */
function createFakeDb(job: {
  company: string | null;
  tenant: string;
  url: string;
}): Database {
  const db = {
    select: () => ({
      from: (table: unknown) => {
        const rows =
          table === jobs
            ? [job]
            : table === answers
              ? []
              : table === documents
                ? []
                : [];
        const chain = {
          where: () => chain,
          limit: () => chain,
          // biome-ignore lint/suspicious/noThenProperty: mimics drizzle's awaitable
          then: (onFulfilled: (v: unknown) => unknown) =>
            Promise.resolve(rows).then(onFulfilled),
        };
        return chain;
      },
    }),
  };
  return db as unknown as Database;
}

function createFakeStorage(): Storage & { puts: string[] } {
  const puts: string[] = [];
  return {
    puts,
    async put(path) {
      puts.push(path);
    },
    async get() {
      return Buffer.from('resume-bytes');
    },
    async exists() {
      return true;
    },
  };
}

function createFakeAccounts(status: string) {
  const setStatus = vi.fn(async () => {});
  const accounts = {
    ensureAccount: vi.fn(async () => ({
      account: { platform: 'workday', tenant: 'cadence', status },
      credential: {
        email: profile.email,
        password: 'Gen-Pw-123!',
      },
      created: status === 'provisioned',
    })),
    setStatus,
    getCredential: vi.fn(),
  };
  return accounts;
}

function task(overrides: Partial<ApplicationTask> = {}): ApplicationTask {
  return {
    id: '3f0c8dbb-6f5e-4b57-9b1c-2a54d2b3c111',
    jobId: 'job-1',
    state: 'FILLING',
    attempt: 1,
    pendingOtp: null,
    jobSpec: {
      platform: 'workday',
      tenant: 'cadence',
      externalId: 'R1',
      title: 'Software Intern',
      applyUrl: 'https://cadence.wd1.myworkdayjobs.com/external_careers/job/X',
      questions: [],
      meta: { site: 'external_careers' },
    },
    ...overrides,
  } as unknown as ApplicationTask;
}

function fakeOpener(page: FakeWorkdayPage): {
  openPage: () => Promise<WorkdayPageSession>;
  closed: { value: boolean };
} {
  const closed = { value: false };
  return {
    closed,
    openPage: async () => ({
      page,
      async close() {
        closed.value = true;
      },
      async finalizeHar() {
        return null;
      },
    }),
  };
}

/** Screens for create-account -> one question page -> review. */
function screens(): FakeScreen[] {
  return [
    {
      heading: 'Software Intern',
      present: ['applyManually'],
      advancesOn: ['applyManually'],
    },
    {
      present: ['email', 'password', 'createAccountSubmitButton'],
      advancesOn: ['createAccountSubmitButton'],
    },
    {
      heading: 'My Information',
      present: ['pageFooterNextButton'],
      fields: [
        {
          automationId: 'firstName',
          label: 'First name',
          control: 'text',
          required: true,
        },
      ],
      advancesOn: ['next'],
    },
    { heading: 'Review' },
  ];
}

describe('createWorkdayWorker.fill', () => {
  it('provisions/creates account, fills, returns FILLED stopped-before-submit', async () => {
    const page = new FakeWorkdayPage(screens());
    const { openPage, closed } = fakeOpener(page);
    const accounts = createFakeAccounts('provisioned');
    const storage = createFakeStorage();

    const worker = createWorkdayWorker({
      db: createFakeDb({ company: 'Cadence', tenant: 'cadence', url: 'u' }),
      storage,
      // biome-ignore lint/suspicious/noExplicitAny: fake accounts
      accounts: accounts as any,
      profile,
      openPage,
    });

    const result = await worker.fill(task());

    expect(result.tier).toBe('T1');
    expect(result.nextEvent).toBe('FILLED');
    expect(result.stoppedBeforeSubmit).toBe(true);
    expect(result.filledFieldCount).toBeGreaterThanOrEqual(0);
    // Account was provisioned -> create intent -> advanced to 'registered'.
    expect(accounts.ensureAccount).toHaveBeenCalledWith({
      platform: 'workday',
      tenant: 'cadence',
      site: 'external_careers',
      email: profile.email,
    });
    expect(accounts.setStatus).toHaveBeenCalledWith(
      'workday',
      'cadence',
      'registered',
    );
    // Screenshots were persisted to the vault, and the page was closed.
    expect(storage.puts.some((p) => p.includes('/screenshots/'))).toBe(true);
    expect(closed.value).toBe(true);
  });

  it('returns NEED_OTP when the flow hits a verification wall', async () => {
    const otpScreens: FakeScreen[] = [
      {
        heading: 'Software Intern',
        present: ['applyManually'],
        advancesOn: ['applyManually'],
      },
      {
        present: ['email', 'password', 'createAccountSubmitButton'],
        advancesOn: ['createAccountSubmitButton'],
      },
      { present: ['verificationCode', 'verifyEmailSubmitButton'] },
    ];
    const page = new FakeWorkdayPage(otpScreens);
    const { openPage } = fakeOpener(page);
    const worker = createWorkdayWorker({
      db: createFakeDb({ company: 'Cadence', tenant: 'cadence', url: 'u' }),
      storage: createFakeStorage(),
      // biome-ignore lint/suspicious/noExplicitAny: fake accounts
      accounts: createFakeAccounts('provisioned') as any,
      profile,
      openPage,
    });

    const result = await worker.fill(task());
    expect(result.nextEvent).toBe('NEED_OTP');
  });

  it('signs in (not create) when the account is already registered', async () => {
    const page = new FakeWorkdayPage([
      {
        heading: 'Software Intern',
        present: ['applyManually'],
        advancesOn: ['applyManually'],
      },
      {
        present: ['email', 'password', 'signInSubmitButton'],
        advancesOn: ['signInSubmitButton'],
      },
      { heading: 'Review' },
    ]);
    const { openPage } = fakeOpener(page);
    const accounts = createFakeAccounts('registered');
    const worker = createWorkdayWorker({
      db: createFakeDb({ company: 'Cadence', tenant: 'cadence', url: 'u' }),
      storage: createFakeStorage(),
      // biome-ignore lint/suspicious/noExplicitAny: fake accounts
      accounts: accounts as any,
      profile,
      openPage,
    });

    await worker.fill(task());
    expect(page.log.clicked).toContain('signInSubmitButton');
    // A sign-in (not a create) leaves status unchanged.
    expect(accounts.setStatus).not.toHaveBeenCalledWith(
      'workday',
      'cadence',
      'registered',
    );
  });

  it('rejects a non-workday task', async () => {
    const worker = createWorkdayWorker({
      db: createFakeDb({ company: null, tenant: 't', url: 'u' }),
      storage: createFakeStorage(),
      // biome-ignore lint/suspicious/noExplicitAny: fake accounts
      accounts: createFakeAccounts('provisioned') as any,
      profile,
      openPage: fakeOpener(new FakeWorkdayPage([])).openPage,
    });
    const greenhouseTask = task({
      // biome-ignore lint/suspicious/noExplicitAny: partial spec for the guard
      jobSpec: { platform: 'greenhouse' } as any,
    });
    await expect(worker.fill(greenhouseTask)).rejects.toThrow(/not a workday/);
  });
});
