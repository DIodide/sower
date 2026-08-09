import { jobNotes } from '@sower/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from './config.js';
import { buildServer } from './server.js';
import type { Deps } from './types.js';

/**
 * /tasks/:id/job-notes routes against a fake db and a mocked fetch: create
 * (parent 404, questionId-must-match-the-spec 400, insert shape), update
 * (task/note 404s, patch semantics incl. questionId:null clearing the tie),
 * delete (task/note 404s, the row removed), and the mirror contract — sync
 * 'skipped: no token' without a token, the GET-sha→PUT flow (create vs
 * update, tied-question labels in the rendered file, the empty file after
 * the last delete), and the rule that a GitHub failure NEVER fails the
 * request. The renderer/slug rules are proven in portfolio-scratchpad.test.ts.
 */

interface Chain {
  from: () => Chain;
  where: () => Chain;
  limit: () => Chain;
  innerJoin: () => Chain;
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
    // biome-ignore lint/suspicious/noThenProperty: intentionally thenable to mimic drizzle's awaitable query builder
    then: (onFulfilled) => Promise.resolve(result).then(onFulfilled),
  };
  return self;
}

interface DbWrite {
  method: 'insert' | 'update' | 'delete';
  table: unknown;
  arg: unknown;
}

function createFakeDb(
  options: {
    selectResults?: unknown[][];
    insertResults?: unknown[][];
    updateResults?: unknown[][];
    deleteResults?: unknown[][];
    writes?: DbWrite[];
  } = {},
): Deps['db'] {
  const selectResults = [...(options.selectResults ?? [])];
  const insertResults = [...(options.insertResults ?? [])];
  const updateResults = [...(options.updateResults ?? [])];
  const deleteResults = [...(options.deleteResults ?? [])];
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
    delete: (table: unknown) => {
      options.writes?.push({ method: 'delete', table, arg: undefined });
      return chain(deleteResults.shift() ?? []);
    },
  };
  return db as unknown as Deps['db'];
}

const baseConfig = {
  INGEST_API_KEY: 'test-key',
  SOWER_ENV: 'test',
} as unknown as Config;

const tokenConfig = {
  ...baseConfig,
  GITHUB_PORTFOLIO_TOKEN: 'gh-secret-token',
} as unknown as Config;

function createDeps(db: Deps['db'], config: Config = baseConfig): Deps {
  return {
    db,
    queue: { enqueueProcess: async () => {} },
    config,
    logger: false,
  };
}

const TASK_ID = 'aaaaaaaa-0000-4000-8000-000000000001';
const NOTE_ID = 'cccccccc-0000-4000-8000-000000000001';
const AUTH = { 'x-api-key': 'test-key' };

/** A jobSpec with one question the tied-note tests bind to. */
const SPEC = {
  platform: 'greenhouse',
  tenant: 'akuna',
  externalId: 'j1',
  title: 'SWE Intern',
  company: 'Akuna Capital',
  applyUrl: 'https://boards.greenhouse.io/akuna/jobs/1',
  questions: [
    {
      id: 'q-why',
      label: 'Why do you want to work here?',
      type: 'textarea',
      required: true,
    },
  ],
};

/** A job_notes row as the db returns it. */
function noteRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: NOTE_ID,
    taskId: TASK_ID,
    questionId: null,
    body: 'remember the OA is 90 min',
    createdAt: new Date('2026-08-01T12:00:00Z'),
    ...overrides,
  };
}

/** The mirror's two db reads: the task+job join, then the notes list. */
function mirrorSelects(notes: unknown[]): unknown[][] {
  return [
    [
      {
        task: { jobSpec: SPEC },
        job: { company: 'Akuna Capital', title: 'SWE Intern' },
      },
    ],
    notes,
  ];
}

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

function fakeResponse(init: {
  ok: boolean;
  status: number;
  body?: unknown;
  text?: string;
}): Response {
  return {
    ok: init.ok,
    status: init.status,
    json: async () => init.body ?? {},
    text: async () => init.text ?? '',
  } as unknown as Response;
}

let fetchCalls: FetchCall[];

function stubFetch(responses: Response[]): void {
  const queue = [...responses];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      fetchCalls.push({ url: String(url), init });
      const next = queue.shift();
      if (!next) throw new Error('unexpected fetch');
      return next;
    }),
  );
}

beforeEach(() => {
  fetchCalls = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('POST /tasks/:id/job-notes', () => {
  it('requires the api key', async () => {
    const app = buildServer(createDeps(createFakeDb()));
    const response = await app.inject({
      method: 'POST',
      url: `/tasks/${TASK_ID}/job-notes`,
      payload: { body: 'x' },
    });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it('rejects an empty body, an over-long body, and an over-long questionId with 400', async () => {
    const app = buildServer(createDeps(createFakeDb()));
    for (const payload of [
      { body: '' },
      { body: '   ' },
      { body: 'x'.repeat(20_001) },
      { body: 'x', questionId: 'q'.repeat(201) },
    ]) {
      const response = await app.inject({
        method: 'POST',
        url: `/tasks/${TASK_ID}/job-notes`,
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
      url: `/tasks/${TASK_ID}/job-notes`,
      headers: AUTH,
      payload: { body: 'x' },
    });
    expect(response.statusCode).toBe(404);
    expect(writes).toHaveLength(0);
    await app.close();
  });

  it("400s a questionId that is not one of the task's questions, writing nothing", async () => {
    const writes: DbWrite[] = [];
    const app = buildServer(
      createDeps(
        createFakeDb({
          selectResults: [[{ id: TASK_ID, jobSpec: SPEC }]],
          writes,
        }),
      ),
    );
    const response = await app.inject({
      method: 'POST',
      url: `/tasks/${TASK_ID}/job-notes`,
      headers: AUTH,
      payload: { body: 'x', questionId: 'q-nope' },
    });
    expect(response.statusCode).toBe(400);
    expect((response.json() as { error: string }).error).toContain('q-nope');
    expect(writes).toHaveLength(0);
    await app.close();
  });

  it("inserts the note and reports sync 'skipped: no token' without a token (no GitHub call)", async () => {
    const writes: DbWrite[] = [];
    stubFetch([]);
    const app = buildServer(
      createDeps(
        createFakeDb({
          selectResults: [[{ id: TASK_ID, jobSpec: SPEC }]],
          insertResults: [[noteRow()]],
          writes,
        }),
      ),
    );
    const response = await app.inject({
      method: 'POST',
      url: `/tasks/${TASK_ID}/job-notes`,
      headers: AUTH,
      payload: { body: 'remember the OA is 90 min' },
    });
    expect(response.statusCode).toBe(200);
    const insert = writes.find((w) => w.method === 'insert');
    expect(insert?.table).toBe(jobNotes);
    expect(insert?.arg).toEqual({
      taskId: TASK_ID,
      body: 'remember the OA is 90 min',
      questionId: null,
    });
    const body = response.json() as { note: { id: string }; sync: string };
    expect(body.note.id).toBe(NOTE_ID);
    expect(body.sync).toBe('skipped: no token');
    expect(fetchCalls).toHaveLength(0);
    await app.close();
  });

  it('mirrors a fresh file (GET 404 → PUT without sha) with the tied-question label rendered', async () => {
    const tied = noteRow({ questionId: 'q-why', body: 'draft: because…' });
    stubFetch([
      fakeResponse({ ok: false, status: 404 }),
      fakeResponse({ ok: true, status: 201, body: { commit: { sha: 'c1' } } }),
    ]);
    const app = buildServer(
      createDeps(
        createFakeDb({
          selectResults: [
            [{ id: TASK_ID, jobSpec: SPEC }],
            ...mirrorSelects([tied]),
          ],
          insertResults: [[tied]],
        }),
        tokenConfig,
      ),
    );
    const response = await app.inject({
      method: 'POST',
      url: `/tasks/${TASK_ID}/job-notes`,
      headers: AUTH,
      payload: { body: 'draft: because…', questionId: 'q-why' },
    });
    expect(response.statusCode).toBe(200);
    expect((response.json() as { sync: string }).sync).toBe('mirrored');
    expect(fetchCalls).toHaveLength(2);
    const expectedUrl =
      'https://api.github.com/repos/DIodide/portfolio/contents/private/jobs/akuna-capital/swe-intern/scratchpad.md';
    expect(fetchCalls[0]?.url).toBe(expectedUrl);
    const put = fetchCalls[1];
    expect(put?.url).toBe(expectedUrl);
    expect(put?.init?.method).toBe('PUT');
    const headers = put?.init?.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer gh-secret-token');
    const putBody = JSON.parse(String(put?.init?.body)) as {
      message: string;
      content: string;
      sha?: string;
    };
    expect(putBody.message).toBe(
      'sower: scratchpad — Akuna Capital / SWE Intern',
    );
    expect(putBody.sha).toBeUndefined();
    expect(Buffer.from(putBody.content, 'base64').toString('utf8')).toBe(
      'Q: Why do you want to work here?\ndraft: because…\n--end\n',
    );
    await app.close();
  });

  it('passes the current blob sha on update (GET 200)', async () => {
    stubFetch([
      fakeResponse({ ok: true, status: 200, body: { sha: 'blob-1' } }),
      fakeResponse({ ok: true, status: 200, body: { commit: { sha: 'c2' } } }),
    ]);
    const app = buildServer(
      createDeps(
        createFakeDb({
          selectResults: [
            [{ id: TASK_ID, jobSpec: SPEC }],
            ...mirrorSelects([noteRow()]),
          ],
          insertResults: [[noteRow()]],
        }),
        tokenConfig,
      ),
    );
    const response = await app.inject({
      method: 'POST',
      url: `/tasks/${TASK_ID}/job-notes`,
      headers: AUTH,
      payload: { body: 'remember the OA is 90 min' },
    });
    expect(response.statusCode).toBe(200);
    expect((response.json() as { sync: string }).sync).toBe('mirrored');
    const putBody = JSON.parse(String(fetchCalls[1]?.init?.body)) as {
      sha?: string;
    };
    expect(putBody.sha).toBe('blob-1');
    await app.close();
  });

  it('still 200s when GitHub fails, reporting sync failed WITHOUT the token', async () => {
    stubFetch([
      fakeResponse({ ok: false, status: 404 }),
      fakeResponse({
        ok: false,
        status: 500,
        text: 'boom gh-secret-token boom',
      }),
    ]);
    const app = buildServer(
      createDeps(
        createFakeDb({
          selectResults: [
            [{ id: TASK_ID, jobSpec: SPEC }],
            ...mirrorSelects([noteRow()]),
          ],
          insertResults: [[noteRow()]],
        }),
        tokenConfig,
      ),
    );
    const response = await app.inject({
      method: 'POST',
      url: `/tasks/${TASK_ID}/job-notes`,
      headers: AUTH,
      payload: { body: 'remember the OA is 90 min' },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { note: { id: string }; sync: string };
    expect(body.note.id).toBe(NOTE_ID);
    expect(body.sync).toMatch(/^failed: /);
    expect(body.sync).not.toContain('gh-secret-token');
    await app.close();
  });

  it('still 200s when the network throws', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNRESET');
      }),
    );
    const app = buildServer(
      createDeps(
        createFakeDb({
          selectResults: [
            [{ id: TASK_ID, jobSpec: SPEC }],
            ...mirrorSelects([noteRow()]),
          ],
          insertResults: [[noteRow()]],
        }),
        tokenConfig,
      ),
    );
    const response = await app.inject({
      method: 'POST',
      url: `/tasks/${TASK_ID}/job-notes`,
      headers: AUTH,
      payload: { body: 'remember the OA is 90 min' },
    });
    expect(response.statusCode).toBe(200);
    expect((response.json() as { sync: string }).sync).toBe(
      'failed: ECONNRESET',
    );
    await app.close();
  });
});

describe('POST /tasks/:id/job-notes/:noteId (update)', () => {
  it('rejects an empty patch, an empty/over-long body, and an over-long questionId with 400', async () => {
    const writes: DbWrite[] = [];
    const app = buildServer(createDeps(createFakeDb({ writes })));
    for (const payload of [
      {},
      { body: '' },
      { body: '   ' },
      { body: 'x'.repeat(20_001) },
      { questionId: 'q'.repeat(201) },
    ]) {
      const response = await app.inject({
        method: 'POST',
        url: `/tasks/${TASK_ID}/job-notes/${NOTE_ID}`,
        headers: AUTH,
        payload,
      });
      expect(response.statusCode).toBe(400);
    }
    expect(writes).toHaveLength(0);
    await app.close();
  });

  it('404s on an unknown task, writing nothing', async () => {
    const writes: DbWrite[] = [];
    const app = buildServer(
      createDeps(createFakeDb({ selectResults: [[]], writes })),
    );
    const response = await app.inject({
      method: 'POST',
      url: `/tasks/${TASK_ID}/job-notes/${NOTE_ID}`,
      headers: AUTH,
      payload: { body: 'updated' },
    });
    expect(response.statusCode).toBe(404);
    expect(writes).toHaveLength(0);
    await app.close();
  });

  it('404s a note that does not exist (or belongs to another task), skipping the mirror', async () => {
    stubFetch([]);
    const app = buildServer(
      createDeps(
        createFakeDb({
          selectResults: [[{ id: TASK_ID, jobSpec: SPEC }]],
          updateResults: [[]],
        }),
        tokenConfig,
      ),
    );
    const response = await app.inject({
      method: 'POST',
      url: `/tasks/${TASK_ID}/job-notes/${NOTE_ID}`,
      headers: AUTH,
      payload: { body: 'updated' },
    });
    expect(response.statusCode).toBe(404);
    expect(fetchCalls).toHaveLength(0);
    await app.close();
  });

  it("400s a questionId that is not one of the task's questions, writing nothing", async () => {
    const writes: DbWrite[] = [];
    const app = buildServer(
      createDeps(
        createFakeDb({
          selectResults: [[{ id: TASK_ID, jobSpec: SPEC }]],
          writes,
        }),
      ),
    );
    const response = await app.inject({
      method: 'POST',
      url: `/tasks/${TASK_ID}/job-notes/${NOTE_ID}`,
      headers: AUTH,
      payload: { questionId: 'q-nope' },
    });
    expect(response.statusCode).toBe(400);
    expect((response.json() as { error: string }).error).toContain('q-nope');
    expect(writes).toHaveLength(0);
    await app.close();
  });

  it("updates only the provided fields and reports sync 'skipped: no token' without a token", async () => {
    const writes: DbWrite[] = [];
    stubFetch([]);
    const app = buildServer(
      createDeps(
        createFakeDb({
          selectResults: [[{ id: TASK_ID, jobSpec: SPEC }]],
          updateResults: [[noteRow({ body: 'updated', questionId: 'q-why' })]],
          writes,
        }),
      ),
    );
    const response = await app.inject({
      method: 'POST',
      url: `/tasks/${TASK_ID}/job-notes/${NOTE_ID}`,
      headers: AUTH,
      payload: { body: 'updated', questionId: 'q-why' },
    });
    expect(response.statusCode).toBe(200);
    const update = writes.find((w) => w.method === 'update');
    expect(update?.table).toBe(jobNotes);
    expect(update?.arg).toEqual({ body: 'updated', questionId: 'q-why' });
    const body = response.json() as { note: { body: string }; sync: string };
    expect(body.note.body).toBe('updated');
    expect(body.sync).toBe('skipped: no token');
    expect(fetchCalls).toHaveLength(0);
    await app.close();
  });

  it('questionId: null clears the tie without touching the body', async () => {
    const writes: DbWrite[] = [];
    const app = buildServer(
      createDeps(
        createFakeDb({
          selectResults: [[{ id: TASK_ID, jobSpec: SPEC }]],
          updateResults: [[noteRow()]],
          writes,
        }),
      ),
    );
    const response = await app.inject({
      method: 'POST',
      url: `/tasks/${TASK_ID}/job-notes/${NOTE_ID}`,
      headers: AUTH,
      payload: { questionId: null },
    });
    expect(response.statusCode).toBe(200);
    const update = writes.find((w) => w.method === 'update');
    expect(update?.arg).toEqual({ questionId: null });
    const body = response.json() as {
      note: { questionId: null };
      sync: string;
    };
    expect(body.note.questionId).toBeNull();
    expect(body.sync).toBe('skipped: no token');
    await app.close();
  });

  it('re-mirrors the scratchpad with the updated text (GET sha → PUT)', async () => {
    const updated = noteRow({ questionId: 'q-why', body: 'updated draft' });
    stubFetch([
      fakeResponse({ ok: true, status: 200, body: { sha: 'blob-1' } }),
      fakeResponse({ ok: true, status: 200, body: { commit: { sha: 'c4' } } }),
    ]);
    const app = buildServer(
      createDeps(
        createFakeDb({
          selectResults: [
            [{ id: TASK_ID, jobSpec: SPEC }],
            ...mirrorSelects([updated]),
          ],
          updateResults: [[updated]],
        }),
        tokenConfig,
      ),
    );
    const response = await app.inject({
      method: 'POST',
      url: `/tasks/${TASK_ID}/job-notes/${NOTE_ID}`,
      headers: AUTH,
      payload: { body: 'updated draft' },
    });
    expect(response.statusCode).toBe(200);
    expect((response.json() as { sync: string }).sync).toBe('mirrored');
    const putBody = JSON.parse(String(fetchCalls[1]?.init?.body)) as {
      content: string;
      sha?: string;
    };
    expect(putBody.sha).toBe('blob-1');
    expect(Buffer.from(putBody.content, 'base64').toString('utf8')).toBe(
      'Q: Why do you want to work here?\nupdated draft\n--end\n',
    );
    await app.close();
  });

  it('still 200s when GitHub fails — the update is in the DB', async () => {
    stubFetch([
      fakeResponse({ ok: false, status: 404 }),
      fakeResponse({ ok: false, status: 500, text: 'boom' }),
    ]);
    const app = buildServer(
      createDeps(
        createFakeDb({
          selectResults: [
            [{ id: TASK_ID, jobSpec: SPEC }],
            ...mirrorSelects([noteRow({ body: 'updated' })]),
          ],
          updateResults: [[noteRow({ body: 'updated' })]],
        }),
        tokenConfig,
      ),
    );
    const response = await app.inject({
      method: 'POST',
      url: `/tasks/${TASK_ID}/job-notes/${NOTE_ID}`,
      headers: AUTH,
      payload: { body: 'updated' },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { note: { id: string }; sync: string };
    expect(body.note.id).toBe(NOTE_ID);
    expect(body.sync).toMatch(/^failed: /);
    await app.close();
  });
});

describe('POST /tasks/:id/job-notes/:noteId/delete', () => {
  it('404s on an unknown task, deleting nothing', async () => {
    const writes: DbWrite[] = [];
    const app = buildServer(
      createDeps(createFakeDb({ selectResults: [[]], writes })),
    );
    const response = await app.inject({
      method: 'POST',
      url: `/tasks/${TASK_ID}/job-notes/${NOTE_ID}/delete`,
      headers: AUTH,
    });
    expect(response.statusCode).toBe(404);
    expect(writes).toHaveLength(0);
    await app.close();
  });

  it('404s a note that does not exist (or belongs to another task), skipping the mirror', async () => {
    stubFetch([]);
    const app = buildServer(
      createDeps(
        createFakeDb({
          selectResults: [[{ id: TASK_ID }]],
          deleteResults: [[]],
        }),
        tokenConfig,
      ),
    );
    const response = await app.inject({
      method: 'POST',
      url: `/tasks/${TASK_ID}/job-notes/${NOTE_ID}/delete`,
      headers: AUTH,
    });
    expect(response.statusCode).toBe(404);
    expect(fetchCalls).toHaveLength(0);
    await app.close();
  });

  it('deletes the row and re-mirrors — the LAST delete writes the empty file, never removes it', async () => {
    const writes: DbWrite[] = [];
    stubFetch([
      fakeResponse({ ok: true, status: 200, body: { sha: 'blob-1' } }),
      fakeResponse({ ok: true, status: 200, body: { commit: { sha: 'c3' } } }),
    ]);
    const app = buildServer(
      createDeps(
        createFakeDb({
          // Task lookup, then the mirror's join + now-empty notes list.
          selectResults: [[{ id: TASK_ID }], ...mirrorSelects([])],
          deleteResults: [[{ id: NOTE_ID }]],
          writes,
        }),
        tokenConfig,
      ),
    );
    const response = await app.inject({
      method: 'POST',
      url: `/tasks/${TASK_ID}/job-notes/${NOTE_ID}/delete`,
      headers: AUTH,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { ok: boolean; sync: string };
    expect(body.ok).toBe(true);
    expect(body.sync).toBe('mirrored');
    expect(writes.find((w) => w.method === 'delete')?.table).toBe(jobNotes);
    // The empty notes list still PUTs — as the empty file, against the sha.
    const putBody = JSON.parse(String(fetchCalls[1]?.init?.body)) as {
      content: string;
      sha?: string;
    };
    expect(putBody.content).toBe('');
    expect(putBody.sha).toBe('blob-1');
    await app.close();
  });

  it("reports sync 'skipped: no token' without a token", async () => {
    const app = buildServer(
      createDeps(
        createFakeDb({
          selectResults: [[{ id: TASK_ID }]],
          deleteResults: [[{ id: NOTE_ID }]],
        }),
      ),
    );
    const response = await app.inject({
      method: 'POST',
      url: `/tasks/${TASK_ID}/job-notes/${NOTE_ID}/delete`,
      headers: AUTH,
    });
    expect(response.statusCode).toBe(200);
    expect((response.json() as { sync: string }).sync).toBe(
      'skipped: no token',
    );
    await app.close();
  });
});
