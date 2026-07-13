import type { Account, Database } from '@sower/db';
import type { Storage } from '@sower/storage';
import { describe, expect, it } from 'vitest';
import {
  type AccountCredential,
  AccountManager,
  credentialStoragePath,
} from './manager.js';

/** In-memory Storage implementing the vault interface. */
function createFakeStorage(): Storage & { objects: Map<string, Buffer> } {
  const objects = new Map<string, Buffer>();
  return {
    objects,
    async put(path, data) {
      objects.set(path, Buffer.from(data));
    },
    async get(path) {
      const value = objects.get(path);
      if (!value) throw new Error(`no object at ${path}`);
      return value;
    },
    async exists(path) {
      return objects.has(path);
    },
  };
}

/**
 * Minimal fake of the drizzle surface AccountManager uses: select().from()
 * .where().limit(), insert().values().onConflictDoNothing().returning(), and
 * update().set().where(). Holds account rows keyed by platform/tenant.
 */
function createFakeDb(): Database & { rows: Account[] } {
  const rows: Account[] = [];
  let nextId = 1;
  const db = {
    rows,
    select: () => ({
      from: () => ({
        where: () => ({
          // Each test uses a single (platform, tenant), and insert() emulates
          // the unique index, so "all rows" is at most the one matching row.
          limit: async () => [...rows],
        }),
      }),
    }),
    insert: () => ({
      values: (value: Record<string, unknown>) => ({
        onConflictDoNothing: () => ({
          returning: async () => {
            const exists = rows.some(
              (row) =>
                row.platform === value.platform && row.tenant === value.tenant,
            );
            if (exists) return [];
            const row = {
              id: `00000000-0000-0000-0000-00000000000${nextId++}`,
              platform: value.platform,
              tenant: value.tenant,
              site: value.site ?? null,
              emailAlias: value.emailAlias ?? null,
              secretRef: value.secretRef ?? null,
              status: value.status ?? 'provisioned',
              createdAt: new Date(),
              updatedAt: new Date(),
            } as Account;
            rows.push(row);
            return [row];
          },
        }),
      }),
    }),
    update: () => ({
      set: (patch: Partial<Account>) => ({
        where: async () => {
          for (const row of rows) {
            Object.assign(row, patch);
          }
        },
      }),
    }),
  };
  return db as unknown as Database & { rows: Account[] };
}

const input = {
  platform: 'workday',
  tenant: 'cadence',
  site: 'External_Careers',
  email: 'ibraheem.amin2@gmail.com',
};

describe('credentialStoragePath', () => {
  it('builds the vault key under accounts/', () => {
    expect(credentialStoragePath('workday', 'cadence')).toBe(
      'accounts/workday/cadence/credential.json',
    );
  });

  it('rejects segments that could escape the prefix', () => {
    expect(() => credentialStoragePath('workday', '../etc')).toThrow(
      /invalid tenant/,
    );
    expect(() => credentialStoragePath('a/b', 'x')).toThrow(/invalid platform/);
    expect(() => credentialStoragePath('workday', '')).toThrow(
      /invalid tenant/,
    );
  });
});

describe('AccountManager.ensureAccount', () => {
  it('provisions a new account: vault credential + DB row, created=true', async () => {
    const storage = createFakeStorage();
    const db = createFakeDb();
    const manager = new AccountManager(db, storage);

    const result = await manager.ensureAccount(input);

    expect(result.created).toBe(true);
    expect(result.account.platform).toBe('workday');
    expect(result.account.tenant).toBe('cadence');
    expect(result.account.status).toBe('provisioned');
    expect(result.account.secretRef).toBe(
      'accounts/workday/cadence/credential.json',
    );
    // Password lives ONLY in the vault, never on the row.
    expect(JSON.stringify(result.account)).not.toContain(
      result.credential.password,
    );
    expect(result.credential.email).toBe(input.email);
    expect(result.credential.password.length).toBeGreaterThanOrEqual(20);

    const stored = JSON.parse(
      storage.objects
        .get('accounts/workday/cadence/credential.json')
        ?.toString('utf8') ?? '{}',
    ) as AccountCredential;
    expect(stored.password).toBe(result.credential.password);
  });

  it('is idempotent: second call returns the SAME credential, created=false', async () => {
    const storage = createFakeStorage();
    const db = createFakeDb();
    const manager = new AccountManager(db, storage);

    const first = await manager.ensureAccount(input);
    const second = await manager.ensureAccount(input);

    expect(second.created).toBe(false);
    expect(second.credential.password).toBe(first.credential.password);
    expect(db.rows).toHaveLength(1);
  });

  it('reuses a vault credential left by a run whose DB insert failed', async () => {
    const storage = createFakeStorage();
    const db = createFakeDb();
    const orphan: AccountCredential = {
      platform: 'workday',
      tenant: 'cadence',
      site: null,
      email: input.email,
      password: 'Orphaned-Pw-From-Prior-Run-42!',
      createdAt: new Date(0).toISOString(),
    };
    await storage.put(
      'accounts/workday/cadence/credential.json',
      Buffer.from(JSON.stringify(orphan)),
    );

    const result = await new AccountManager(db, storage).ensureAccount(input);

    // The possibly-already-used password is preserved, never regenerated.
    expect(result.credential.password).toBe(orphan.password);
    expect(result.created).toBe(true);
  });

  it('getCredential returns null when no account exists', async () => {
    const manager = new AccountManager(createFakeDb(), createFakeStorage());
    expect(await manager.getCredential('workday', 'nowhere')).toBeNull();
  });

  it('setStatus advances the lifecycle', async () => {
    const storage = createFakeStorage();
    const db = createFakeDb();
    const manager = new AccountManager(db, storage);
    await manager.ensureAccount(input);

    await manager.setStatus('workday', 'cadence', 'registered');

    expect(db.rows[0]?.status).toBe('registered');
  });
});
