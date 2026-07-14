import { answers } from '@sower/db';
import { describe, expect, it } from 'vitest';
import type { Config } from './config.js';
import { buildServer } from './server.js';
import type { Deps } from './types.js';

/**
 * Fake drizzle surface for the /answer-library routes. Results are canned
 * per-call queues; the arguments the routes pass (insert values, upsert
 * conflict config, update sets) are recorded so tests can assert the exact
 * rows written — company normalization, normalizedLabel computation,
 * source 'user', created_at bumping.
 */
interface Recorded {
  insertValues: unknown[];
  conflictTargets: unknown[];
  conflictSets: unknown[];
  updateSets: unknown[];
  deleteCalls: number;
}

function createFakeDb(
  options: {
    selectResults?: unknown[][];
    insertResults?: unknown[][];
    updateResults?: unknown[][];
    /** When set, awaiting the update chain rejects with this error. */
    updateError?: unknown;
    deleteResults?: unknown[][];
  } = {},
): { db: Deps['db']; recorded: Recorded } {
  const recorded: Recorded = {
    insertValues: [],
    conflictTargets: [],
    conflictSets: [],
    updateSets: [],
    deleteCalls: 0,
  };
  const selectResults = [...(options.selectResults ?? [])];
  const insertResults = [...(options.insertResults ?? [])];
  const updateResults = [...(options.updateResults ?? [])];
  const deleteResults = [...(options.deleteResults ?? [])];

  const thenable = (promise: Promise<unknown>) => ({
    // biome-ignore lint/suspicious/noThenProperty: mimics drizzle's awaitable builder
    then: (
      onFulfilled: (value: unknown) => unknown,
      onRejected?: (reason: unknown) => unknown,
    ) => promise.then(onFulfilled, onRejected),
  });

  const db = {
    select: () => {
      const result = selectResults.shift() ?? [];
      const chain = {
        from: () => chain,
        orderBy: () => chain,
        ...thenable(Promise.resolve(result)),
      };
      return chain;
    },
    insert: () => ({
      values: (values: unknown) => {
        recorded.insertValues.push(values);
        return {
          onConflictDoUpdate: (config: { target: unknown; set: unknown }) => {
            recorded.conflictTargets.push(config.target);
            recorded.conflictSets.push(config.set);
            return {
              returning: () =>
                thenable(Promise.resolve(insertResults.shift() ?? [])),
            };
          },
        };
      },
    }),
    update: () => ({
      set: (set: unknown) => {
        recorded.updateSets.push(set);
        return {
          where: () => ({
            returning: () =>
              thenable(
                options.updateError !== undefined
                  ? Promise.reject(options.updateError)
                  : Promise.resolve(updateResults.shift() ?? []),
              ),
          }),
        };
      },
    }),
    delete: () => {
      recorded.deleteCalls += 1;
      return {
        where: () => ({
          returning: () =>
            thenable(Promise.resolve(deleteResults.shift() ?? [])),
        }),
      };
    },
  };
  return { db: db as unknown as Deps['db'], recorded };
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
  SOWER_SUBMIT_ENABLED: 'false',
  SOWER_ENV: 'test',
  DISCORD_BOT_TOKEN: undefined,
  DISCORD_PUBLIC_KEY: 'test-public-key',
  DISCORD_APP_ID: 'test-app-id',
  DISCORD_CHANNEL_MAP: undefined,
  DISCORD_ENABLED: false,
  INVESTIGATOR_JOB_NAME: 'sower-investigator',
  SCREENSHOT_INVESTIGATION_ENABLED: false,
};

function createApp(db: Deps['db']) {
  return buildServer({
    db,
    queue: { enqueueProcess: async () => {} },
    config,
    logger: false,
  });
}

const KEY = { 'x-api-key': 'test-key' };
const ID = '7d8e9f10-1112-4314-a516-b71819c2d2e2';

/** A stored answers row as the fake db returns it (full table shape). */
function storedRow(
  overrides: Partial<{
    id: string;
    company: string;
    questionLabel: string;
    normalizedLabel: string;
    value: unknown;
    source: string;
    createdAt: Date;
  }> = {},
) {
  return {
    id: ID,
    company: 'acme corp',
    questionLabel: 'Why do you want to work here?',
    normalizedLabel: 'why do you want to work here',
    value: 'Because Acme builds anvils.',
    source: 'user',
    createdAt: new Date('2026-07-11T00:00:00.000Z'),
    ...overrides,
  };
}

/** The public shape toLibraryRow produces for `storedRow()`, JSON-serialized. */
function publicRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: ID,
    company: 'acme corp',
    questionLabel: 'Why do you want to work here?',
    normalizedLabel: 'why do you want to work here',
    value: 'Because Acme builds anvils.',
    updatedAt: '2026-07-11T00:00:00.000Z',
    ...overrides,
  };
}

describe('GET /answer-library', () => {
  it('responds 401 without an api key', async () => {
    const { db } = createFakeDb();
    const res = await createApp(db).inject({
      method: 'GET',
      url: '/answer-library',
    });
    expect(res.statusCode).toBe(401);
  });

  it('lists every entry (global + all companies) in the public shape', async () => {
    // The route selects the public projection directly (updatedAt aliased
    // from created_at), so the fake returns rows in that shape.
    const rows = [
      {
        id: 'a1',
        company: '',
        questionLabel: 'Pronouns',
        normalizedLabel: 'pronouns',
        value: 'they/them',
        updatedAt: new Date('2026-07-01T00:00:00.000Z'),
      },
      {
        id: 'a2',
        company: 'acme corp',
        questionLabel: 'Why do you want to work here?',
        normalizedLabel: 'why do you want to work here',
        value: 'Because Acme builds anvils.',
        updatedAt: new Date('2026-07-02T00:00:00.000Z'),
      },
    ];
    const { db } = createFakeDb({ selectResults: [rows] });
    const res = await createApp(db).inject({
      method: 'GET',
      url: '/answer-library',
      headers: KEY,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      answers: [
        {
          id: 'a1',
          company: '',
          questionLabel: 'Pronouns',
          normalizedLabel: 'pronouns',
          value: 'they/them',
          updatedAt: '2026-07-01T00:00:00.000Z',
        },
        {
          id: 'a2',
          company: 'acme corp',
          questionLabel: 'Why do you want to work here?',
          normalizedLabel: 'why do you want to work here',
          value: 'Because Acme builds anvils.',
          updatedAt: '2026-07-02T00:00:00.000Z',
        },
      ],
    });
  });

  it('?company= isolates one company: same question under another company or global is excluded', async () => {
    const shared = {
      questionLabel: 'Why do you want to work here?',
      normalizedLabel: 'why do you want to work here',
      updatedAt: new Date('2026-07-01T00:00:00.000Z'),
    };
    const rows = [
      { id: 'a1', company: 'acme corp', value: 'Anvils.', ...shared },
      { id: 'a2', company: 'globex', value: 'Global reach.', ...shared },
      { id: 'a3', company: '', value: 'Generic enthusiasm.', ...shared },
    ];
    const { db } = createFakeDb({ selectResults: [rows] });
    // Raw company text: the filter must normalize ' Acme CORP ' -> 'acme corp'.
    const res = await createApp(db).inject({
      method: 'GET',
      url: '/answer-library?company=%20Acme%20CORP%20',
      headers: KEY,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { answers: Array<{ id: string }> };
    expect(body.answers.map((row) => row.id)).toEqual(['a1']);
  });

  it('?company= with an empty value lists only GLOBAL entries', async () => {
    const rows = [
      {
        id: 'a1',
        company: 'acme corp',
        questionLabel: 'Q',
        normalizedLabel: 'q',
        value: 'scoped',
        updatedAt: new Date('2026-07-01T00:00:00.000Z'),
      },
      {
        id: 'a2',
        company: '',
        questionLabel: 'Q',
        normalizedLabel: 'q',
        value: 'global',
        updatedAt: new Date('2026-07-01T00:00:00.000Z'),
      },
    ];
    const { db } = createFakeDb({ selectResults: [rows] });
    const res = await createApp(db).inject({
      method: 'GET',
      url: '/answer-library?company=',
      headers: KEY,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { answers: Array<{ id: string }> };
    expect(body.answers.map((row) => row.id)).toEqual(['a2']);
  });
});

describe('POST /answer-library', () => {
  it('upserts a company-scoped entry by (companyKey, normalizedLabel)', async () => {
    const { db, recorded } = createFakeDb({ insertResults: [[storedRow()]] });
    const res = await createApp(db).inject({
      method: 'POST',
      url: '/answer-library',
      headers: KEY,
      payload: {
        company: '  Acme Corp ',
        questionLabel: '  Why do you want to work here?  ',
        value: 'Because Acme builds anvils.',
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ answer: publicRow() });
    // The inserted row: normalized companyKey, trimmed label, computed
    // normalizedLabel, source 'user'.
    expect(recorded.insertValues).toEqual([
      {
        company: 'acme corp',
        questionLabel: 'Why do you want to work here?',
        normalizedLabel: 'why do you want to work here',
        value: 'Because Acme builds anvils.',
        source: 'user',
      },
    ]);
    // Conflict target is the (company, normalized_label) unique index...
    const target = recorded.conflictTargets[0] as unknown[];
    expect(target).toHaveLength(2);
    expect(target[0]).toBe(answers.company);
    expect(target[1]).toBe(answers.normalizedLabel);
    // ...and the conflict update replaces the value and bumps the last-write
    // timestamp (created_at doubles as updated_at — the table has no other).
    expect(recorded.conflictSets[0]).toMatchObject({
      questionLabel: 'Why do you want to work here?',
      value: 'Because Acme builds anvils.',
      source: 'user',
    });
    expect(
      (recorded.conflictSets[0] as { createdAt: unknown }).createdAt,
    ).toBeInstanceOf(Date);
  });

  it('stores a GLOBAL entry (company "") when no company is given', async () => {
    const { db, recorded } = createFakeDb({
      insertResults: [[storedRow({ company: '' })]],
    });
    const res = await createApp(db).inject({
      method: 'POST',
      url: '/answer-library',
      headers: KEY,
      payload: { questionLabel: 'Pronouns', value: 'they/them' },
    });
    expect(res.statusCode).toBe(200);
    expect((recorded.insertValues[0] as { company: string }).company).toBe('');
  });

  it('accepts a multiselect-style string[] value', async () => {
    const { db, recorded } = createFakeDb({
      insertResults: [[storedRow({ value: ['A', 'B'] })]],
    });
    const res = await createApp(db).inject({
      method: 'POST',
      url: '/answer-library',
      headers: KEY,
      payload: { questionLabel: 'Which offices?', value: ['A', 'B'] },
    });
    expect(res.statusCode).toBe(200);
    expect((recorded.insertValues[0] as { value: unknown }).value).toEqual([
      'A',
      'B',
    ]);
  });

  it('responds 400 for a missing value, empty label, or punctuation-only label', async () => {
    for (const payload of [
      { questionLabel: 'Why here?' }, // no value
      { questionLabel: 'Why here?', value: '' }, // empty value
      { questionLabel: '', value: 'x' }, // empty label
      { questionLabel: '?!¿', value: 'x' }, // normalizes to ''
    ]) {
      const { db, recorded } = createFakeDb();
      const res = await createApp(db).inject({
        method: 'POST',
        url: '/answer-library',
        headers: KEY,
        payload,
      });
      expect(res.statusCode).toBe(400);
      expect(recorded.insertValues).toHaveLength(0);
    }
  });
});

describe('PUT /answer-library/:id', () => {
  it('updates the value and bumps the last-write timestamp', async () => {
    const updated = storedRow({ value: 'New answer.' });
    const { db, recorded } = createFakeDb({ updateResults: [[updated]] });
    const res = await createApp(db).inject({
      method: 'PUT',
      url: `/answer-library/${ID}`,
      headers: KEY,
      payload: { value: 'New answer.' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ answer: publicRow({ value: 'New answer.' }) });
    const set = recorded.updateSets[0] as Record<string, unknown>;
    expect(set.value).toBe('New answer.');
    expect(set.createdAt).toBeInstanceOf(Date);
    // Label and scope untouched when not provided.
    expect('questionLabel' in set).toBe(false);
    expect('normalizedLabel' in set).toBe(false);
    expect('company' in set).toBe(false);
  });

  it('recomputes normalizedLabel on label change and normalizes a company change', async () => {
    const { db, recorded } = createFakeDb({ updateResults: [[storedRow()]] });
    const res = await createApp(db).inject({
      method: 'PUT',
      url: `/answer-library/${ID}`,
      headers: KEY,
      payload: {
        value: 'v',
        questionLabel: ' Why Acme?! ',
        company: ' GLOBEX ',
      },
    });
    expect(res.statusCode).toBe(200);
    expect(recorded.updateSets[0]).toMatchObject({
      value: 'v',
      questionLabel: 'Why Acme?!',
      normalizedLabel: 'why acme',
      company: 'globex',
    });
  });

  it('responds 404 when the id matches no row', async () => {
    const { db } = createFakeDb({ updateResults: [[]] });
    const res = await createApp(db).inject({
      method: 'PUT',
      url: `/answer-library/${ID}`,
      headers: KEY,
      payload: { value: 'v' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'answer not found' });
  });

  it('responds 409 when rescoping collides with an existing (company, question) row', async () => {
    // Both the raw postgres error shape and drizzle's wrapped (cause) shape.
    for (const updateError of [
      { code: '23505' },
      { message: 'query failed', cause: { code: '23505' } },
    ]) {
      const { db } = createFakeDb({ updateError });
      const res = await createApp(db).inject({
        method: 'PUT',
        url: `/answer-library/${ID}`,
        headers: KEY,
        payload: { value: 'v', company: 'globex' },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({
        error: 'an answer for that company and question already exists',
      });
    }
  });

  it('responds 400 for a non-uuid id or an invalid body', async () => {
    const { db } = createFakeDb();
    const app = createApp(db);
    const badId = await app.inject({
      method: 'PUT',
      url: '/answer-library/not-a-uuid',
      headers: KEY,
      payload: { value: 'v' },
    });
    expect(badId.statusCode).toBe(400);
    const badBody = await app.inject({
      method: 'PUT',
      url: `/answer-library/${ID}`,
      headers: KEY,
      payload: { questionLabel: 'no value' },
    });
    expect(badBody.statusCode).toBe(400);
  });
});

describe('DELETE /answer-library/:id', () => {
  it('deletes an entry', async () => {
    const { db, recorded } = createFakeDb({ deleteResults: [[{ id: ID }]] });
    const res = await createApp(db).inject({
      method: 'DELETE',
      url: `/answer-library/${ID}`,
      headers: KEY,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ deleted: true });
    expect(recorded.deleteCalls).toBe(1);
  });

  it('responds 404 when the id matches no row', async () => {
    const { db } = createFakeDb({ deleteResults: [[]] });
    const res = await createApp(db).inject({
      method: 'DELETE',
      url: `/answer-library/${ID}`,
      headers: KEY,
    });
    expect(res.statusCode).toBe(404);
  });

  it('responds 400 for a non-uuid id', async () => {
    const { db, recorded } = createFakeDb();
    const res = await createApp(db).inject({
      method: 'DELETE',
      url: '/answer-library/42',
      headers: KEY,
    });
    expect(res.statusCode).toBe(400);
    expect(recorded.deleteCalls).toBe(0);
  });
});
