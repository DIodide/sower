import { emptyProfile, type Profile } from '@sower/answers';
import { profiles } from '@sower/db';
import { describe, expect, it } from 'vitest';
import type { Config } from './config.js';
import { buildServer } from './server.js';
import type { Deps } from './types.js';

/**
 * /profile routes against a fake db: the single-row upsert semantics (update
 * when a row exists, insert otherwise), ProfileSchema validation on PUT, and
 * the empty-profile GET for an unconfigured deployment.
 */

interface Chain {
  from: () => Chain;
  where: () => Chain;
  limit: () => Chain;
  orderBy: () => Chain;
  values: (arg?: unknown) => Chain;
  set: (arg?: unknown) => Chain;
  then: (onFulfilled: (value: unknown) => unknown) => Promise<unknown>;
}

function chain(result: unknown, onArg?: (arg: unknown) => void): Chain {
  const self: Chain = {
    from: () => self,
    where: () => self,
    limit: () => self,
    orderBy: () => self,
    values: (arg?: unknown) => {
      onArg?.(arg);
      return self;
    },
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
  kind: 'insert' | 'update';
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
      chain([], (arg) => options.writes?.push({ kind: 'insert', table, arg })),
    update: (table: unknown) =>
      chain([], (arg) => options.writes?.push({ kind: 'update', table, arg })),
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

/** A minimal profile that passes ProfileSchema. */
function validProfile(): Profile {
  return {
    name: { first: 'Ada', last: 'Lovelace' },
    email: 'ada@example.com',
    phone: '+1 555 0199',
    location: { city: 'London', state: 'LDN', country: 'UK' },
    links: {},
    education: [],
    work: [],
    authorization: { usWorkAuthorized: true, requiresSponsorship: false },
    custom: {},
  };
}

const PROFILE_ROW_ID = '5f1b2c3d-4e5f-4a60-8b71-92c3d4e5f6a7';

describe('GET /profile', () => {
  it('requires the api key', async () => {
    const app = buildServer(createDeps(createFakeDb()));
    const response = await app.inject({ method: 'GET', url: '/profile' });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it('serves the empty profile (configured:false) when no row exists', async () => {
    const app = buildServer(createDeps(createFakeDb({ selectResults: [[]] })));
    const response = await app.inject({
      method: 'GET',
      url: '/profile',
      headers: { 'x-api-key': 'test-key' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      profile: emptyProfile(),
      updatedAt: null,
      configured: false,
    });
    await app.close();
  });

  it('serves the newest row by updatedAt with configured:true', async () => {
    const newest = validProfile();
    const older = { ...validProfile(), email: 'old@example.com' };
    const db = createFakeDb({
      selectResults: [
        [
          {
            id: 'row-old',
            data: older,
            updatedAt: new Date('2026-01-01T00:00:00Z'),
          },
          {
            id: PROFILE_ROW_ID,
            data: newest,
            updatedAt: new Date('2026-07-01T00:00:00Z'),
          },
        ],
      ],
    });
    const app = buildServer(createDeps(db));
    const response = await app.inject({
      method: 'GET',
      url: '/profile',
      headers: { 'x-api-key': 'test-key' },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      profile: Profile;
      updatedAt: string;
      configured: boolean;
    };
    expect(body.configured).toBe(true);
    expect(body.profile.email).toBe('ada@example.com');
    expect(body.updatedAt).toBe('2026-07-01T00:00:00.000Z');
    await app.close();
  });
});

describe('PUT /profile', () => {
  it('rejects an invalid profile with 400 and issues, writing nothing', async () => {
    const writes: DbWrite[] = [];
    const app = buildServer(createDeps(createFakeDb({ writes })));
    const response = await app.inject({
      method: 'PUT',
      url: '/profile',
      headers: { 'x-api-key': 'test-key' },
      payload: { name: { first: 'Ada' } },
    });
    expect(response.statusCode).toBe(400);
    const body = response.json() as { error: string; issues: unknown[] };
    expect(body.error).toBe('invalid profile');
    expect(body.issues.length).toBeGreaterThan(0);
    expect(writes).toHaveLength(0);
    await app.close();
  });

  it('inserts the first row when none exists', async () => {
    const writes: DbWrite[] = [];
    const db = createFakeDb({ selectResults: [[]], writes });
    const app = buildServer(createDeps(db));
    const response = await app.inject({
      method: 'PUT',
      url: '/profile',
      headers: { 'x-api-key': 'test-key' },
      payload: validProfile(),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true });
    expect(writes).toHaveLength(1);
    expect(writes[0]?.kind).toBe('insert');
    expect(writes[0]?.table).toBe(profiles);
    expect(writes[0]?.arg).toMatchObject({ data: validProfile() });
    await app.close();
  });

  it('updates the existing row (single-row upsert, never a second insert)', async () => {
    const writes: DbWrite[] = [];
    const db = createFakeDb({
      selectResults: [[{ id: PROFILE_ROW_ID }]],
      writes,
    });
    const app = buildServer(createDeps(db));
    const changed = { ...validProfile(), email: 'ada+new@example.com' };
    const response = await app.inject({
      method: 'PUT',
      url: '/profile',
      headers: { 'x-api-key': 'test-key' },
      payload: changed,
    });
    expect(response.statusCode).toBe(200);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.kind).toBe('update');
    expect(writes[0]?.table).toBe(profiles);
    expect(writes[0]?.arg).toMatchObject({
      data: { ...changed, email: 'ada+new@example.com' },
    });
    await app.close();
  });

  it('strips unknown keys via ProfileSchema before storing', async () => {
    const writes: DbWrite[] = [];
    const db = createFakeDb({ selectResults: [[]], writes });
    const app = buildServer(createDeps(db));
    const response = await app.inject({
      method: 'PUT',
      url: '/profile',
      headers: { 'x-api-key': 'test-key' },
      payload: { ...validProfile(), sneaky: 'field' },
    });
    expect(response.statusCode).toBe(200);
    const stored = writes[0]?.arg as { data: Record<string, unknown> };
    expect(stored.data).not.toHaveProperty('sneaky');
    await app.close();
  });
});
