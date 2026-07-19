import { resumeLinks } from '@sower/db';
import { describe, expect, it, vi } from 'vitest';
import type { Config } from './config.js';
import { generateLinkToken } from './resume-links.js';
import { buildServer } from './server.js';
import type { Deps } from './types.js';

interface Chain {
  from: () => Chain;
  where: () => Chain;
  limit: () => Chain;
  orderBy: () => Chain;
  values: (arg?: unknown) => Chain;
  set: (arg?: unknown) => Chain;
  returning: () => Chain;
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
    returning: () => self,
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
) {
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

function createFakeStorage(blobs: Record<string, Buffer> = {}) {
  const gets: string[] = [];
  const storage = {
    put: async () => {},
    get: async (path: string) => {
      gets.push(path);
      const blob = blobs[path];
      if (!blob) throw new Error('no such blob');
      return blob;
    },
    exists: async () => false,
  };
  return { storage, gets };
}

const baseConfig = {
  INGEST_API_KEY: 'test-key',
  SOWER_ENV: 'test',
} as unknown as Config;

function createDeps(
  db: Deps['db'],
  overrides: {
    config?: Partial<Config>;
    storage?: Deps['storage'];
  } = {},
): Deps {
  return {
    db,
    queue: { enqueueProcess: vi.fn(async () => {}) },
    config: { ...baseConfig, ...overrides.config } as Config,
    storage: overrides.storage,
    logger: false,
  };
}

const RESUME_ID = '3f0a1b2c-4d5e-4f60-8172-93a4b5c6d7e8';
const LINK_ID = '9e8d7c6b-5a49-4838-a716-05f4e3d2c1b0';
const TOKEN = 'A-Zaz09_-tokentokentokentoken123';

const resumeRow = {
  id: RESUME_ID,
  name: 'swe-2027',
  texPath: 'developer/resumes/swe-2027.tex',
  texSource: '\\documentclass{article}',
  pdfStoragePath: 'resumes/swe-2027/swe-2027.pdf',
  documentId: null,
  lastCommitSha: 'abc123',
  updatedAt: new Date('2026-07-01T00:00:00Z'),
};

const linkRow = {
  id: LINK_ID,
  resumeId: RESUME_ID,
  name: 'Stripe application',
  token: TOKEN,
  enabled: true,
  viewCount: 3,
  lastViewedAt: null,
  createdAt: new Date('2026-07-01T00:00:00Z'),
};

describe('generateLinkToken', () => {
  it('produces >=32 url-safe chars with fresh entropy each call', () => {
    const a = generateLinkToken();
    const b = generateLinkToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    expect(b).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    expect(a).not.toBe(b);
  });
});

describe('share link management routes', () => {
  it('POST /resumes/:id/links requires the api key', async () => {
    const app = buildServer(createDeps(createFakeDb()));
    const response = await app.inject({
      method: 'POST',
      url: `/resumes/${RESUME_ID}/links`,
      payload: { name: 'Stripe application' },
    });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it('POST /resumes/:id/links creates a link with a crypto-random token and returns the public URL', async () => {
    const writes: DbWrite[] = [];
    const db = createFakeDb({
      selectResults: [[{ id: RESUME_ID }]],
      insertResults: [[linkRow]],
      writes,
    });
    const app = buildServer(createDeps(db));
    const response = await app.inject({
      method: 'POST',
      url: `/resumes/${RESUME_ID}/links`,
      headers: { 'x-api-key': 'test-key' },
      payload: { name: 'Stripe application' },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { link: { token: string; url: string } };
    expect(body.link.token).toBe(TOKEN);
    // Without PUBLIC_API_BASE_URL the URL derives from the request host.
    expect(body.link.url).toMatch(/^http/);
    expect(body.link.url.endsWith(`/r/${TOKEN}`)).toBe(true);
    // The stored token is freshly generated and unguessable.
    expect(writes[0]?.table).toBe(resumeLinks);
    const arg = writes[0]?.arg as { resumeId: string; token: string };
    expect(arg.resumeId).toBe(RESUME_ID);
    expect(arg.token).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    await app.close();
  });

  it('POST /resumes/:id/links prefers PUBLIC_API_BASE_URL for the URL', async () => {
    const db = createFakeDb({
      selectResults: [[{ id: RESUME_ID }]],
      insertResults: [[linkRow]],
    });
    const app = buildServer(
      createDeps(db, {
        config: { PUBLIC_API_BASE_URL: 'https://api.sower.example/' },
      }),
    );
    const response = await app.inject({
      method: 'POST',
      url: `/resumes/${RESUME_ID}/links`,
      headers: { 'x-api-key': 'test-key' },
      payload: { name: 'Stripe application' },
    });
    expect((response.json() as { link: { url: string } }).link.url).toBe(
      `https://api.sower.example/r/${TOKEN}`,
    );
    await app.close();
  });

  it('POST /resumes/:id/links 404s on an unknown resume', async () => {
    const db = createFakeDb({ selectResults: [[]] });
    const app = buildServer(createDeps(db));
    const response = await app.inject({
      method: 'POST',
      url: `/resumes/${RESUME_ID}/links`,
      headers: { 'x-api-key': 'test-key' },
      payload: { name: 'Stripe application' },
    });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it('GET /resumes/:id/links lists links with their URLs', async () => {
    const db = createFakeDb({
      selectResults: [[{ id: RESUME_ID }], [linkRow]],
    });
    const app = buildServer(createDeps(db));
    const response = await app.inject({
      method: 'GET',
      url: `/resumes/${RESUME_ID}/links`,
      headers: { 'x-api-key': 'test-key' },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { links: { id: string; url: string }[] };
    expect(body.links).toHaveLength(1);
    expect(body.links[0]?.id).toBe(LINK_ID);
    expect(body.links[0]?.url.endsWith(`/r/${TOKEN}`)).toBe(true);
    await app.close();
  });

  it('POST /resumes/links/:linkId/disable revokes (and /enable restores)', async () => {
    const writes: DbWrite[] = [];
    const db = createFakeDb({
      updateResults: [[{ ...linkRow, enabled: false }], [linkRow]],
      writes,
    });
    const app = buildServer(createDeps(db));
    const disable = await app.inject({
      method: 'POST',
      url: `/resumes/links/${LINK_ID}/disable`,
      headers: { 'x-api-key': 'test-key' },
    });
    expect(disable.statusCode).toBe(200);
    expect(
      (disable.json() as { link: { enabled: boolean } }).link.enabled,
    ).toBe(false);
    const enable = await app.inject({
      method: 'POST',
      url: `/resumes/links/${LINK_ID}/enable`,
      headers: { 'x-api-key': 'test-key' },
    });
    expect(enable.statusCode).toBe(200);
    expect(writes.map((w) => w.arg)).toEqual([
      { enabled: false },
      { enabled: true },
    ]);
    await app.close();
  });

  it('POST /resumes/links/:linkId/disable 404s on an unknown link', async () => {
    const db = createFakeDb({ updateResults: [[]] });
    const app = buildServer(createDeps(db));
    const response = await app.inject({
      method: 'POST',
      url: `/resumes/links/${LINK_ID}/disable`,
      headers: { 'x-api-key': 'test-key' },
    });
    expect(response.statusCode).toBe(404);
    await app.close();
  });
});

describe('GET /r/:token (public share viewer)', () => {
  it('is EXEMPT from x-api-key and streams the current PDF inline', async () => {
    const pdf = Buffer.from('%PDF-1.7 current');
    const writes: DbWrite[] = [];
    const db = createFakeDb({
      selectResults: [[linkRow], [resumeRow]],
      writes,
    });
    const { storage, gets } = createFakeStorage({
      'resumes/swe-2027/swe-2027.pdf': pdf,
    });
    const app = buildServer(createDeps(db, { storage }));
    // NO x-api-key header — the token is the auth.
    const response = await app.inject({ method: 'GET', url: `/r/${TOKEN}` });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('application/pdf');
    expect(response.headers['content-disposition']).toBe(
      'inline; filename="swe-2027.pdf"',
    );
    // Always-current + instantly revocable.
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.rawPayload.equals(pdf)).toBe(true);
    // The CURRENT pdf path came from OUR resumes row.
    expect(gets).toEqual(['resumes/swe-2027/swe-2027.pdf']);
    // View stats recorded.
    expect(writes).toHaveLength(1);
    expect(writes[0]?.method).toBe('update');
    expect(writes[0]?.table).toBe(resumeLinks);
    const set = writes[0]?.arg as { lastViewedAt: unknown; viewCount: unknown };
    expect(set.lastViewedAt).toBeInstanceOf(Date);
    expect(set.viewCount).toBeDefined();
    await app.close();
  });

  it('404s a DISABLED link without reading storage or writing stats', async () => {
    const writes: DbWrite[] = [];
    const db = createFakeDb({
      selectResults: [[{ ...linkRow, enabled: false }]],
      writes,
    });
    const { storage, gets } = createFakeStorage();
    const app = buildServer(createDeps(db, { storage }));
    const response = await app.inject({ method: 'GET', url: `/r/${TOKEN}` });
    expect(response.statusCode).toBe(404);
    expect(response.body).toBe('not found');
    expect(gets).toEqual([]);
    expect(writes).toEqual([]);
    await app.close();
  });

  it('404s an UNKNOWN token with no DB write (rate-limit friendly)', async () => {
    const writes: DbWrite[] = [];
    const db = createFakeDb({ selectResults: [[]], writes });
    const app = buildServer(createDeps(db));
    const response = await app.inject({
      method: 'GET',
      url: `/r/${'x'.repeat(32)}`,
    });
    expect(response.statusCode).toBe(404);
    expect(response.body).toBe('not found');
    expect(writes).toEqual([]);
    await app.close();
  });

  it('404s a MALFORMED token before any DB query', async () => {
    const db = createFakeDb();
    const app = buildServer(createDeps(db));
    for (const bad of [
      'short',
      'has spaces here padpadpadpadpadpad',
      'a!'.repeat(20),
    ]) {
      const response = await app.inject({
        method: 'GET',
        url: `/r/${encodeURIComponent(bad)}`,
      });
      expect(response.statusCode).toBe(404);
    }
    expect(db.selectCount()).toBe(0);
    await app.close();
  });

  it('404s when the resume has no PDF yet or the blob is gone', async () => {
    // No pdfStoragePath.
    const db1 = createFakeDb({
      selectResults: [[linkRow], [{ ...resumeRow, pdfStoragePath: null }]],
    });
    const { storage: storage1 } = createFakeStorage();
    const app1 = buildServer(createDeps(db1, { storage: storage1 }));
    const noPath = await app1.inject({ method: 'GET', url: `/r/${TOKEN}` });
    expect(noPath.statusCode).toBe(404);
    await app1.close();

    // Path present but the blob is missing from the vault.
    const writes: DbWrite[] = [];
    const db2 = createFakeDb({
      selectResults: [[linkRow], [resumeRow]],
      writes,
    });
    const { storage: storage2 } = createFakeStorage();
    const app2 = buildServer(createDeps(db2, { storage: storage2 }));
    const noBlob = await app2.inject({ method: 'GET', url: `/r/${TOKEN}` });
    expect(noBlob.statusCode).toBe(404);
    // No stats for a failed serve.
    expect(writes).toEqual([]);
    await app2.close();
  });
});
