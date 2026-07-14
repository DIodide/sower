import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { run } from './main.js';

const state = vi.hoisted(() => ({
  taskRows: [] as unknown[],
  jobRows: [] as unknown[],
  documentRows: [] as unknown[],
  storageGets: [] as string[],
  imageBytes: Buffer.from('png-bytes'),
  investigateCalls: [] as {
    image: Buffer;
    contentType: string;
    hint?: string;
  }[],
  outcome: {
    result: {
      found: true,
      applyUrl: 'https://boards.greenhouse.io/acme/jobs/123',
      confidence: 'high',
      notes: 'ok',
    },
    transcript: [{ seq: 0, kind: 'assistant_text', text: 'looking', ts: 1 }],
  },
}));

vi.mock('@sower/db', () => {
  const applicationTasks = { name: 'application_tasks', id: 'at.id' };
  const jobs = { name: 'jobs', id: 'jobs.id' };
  const documents = {
    name: 'documents',
    jobId: 'documents.jobId',
    kind: 'documents.kind',
    createdAt: 'documents.createdAt',
  };
  const rowsFor = (table: unknown) => {
    if (table === applicationTasks) return state.taskRows;
    if (table === jobs) return state.jobRows;
    return state.documentRows;
  };
  return {
    applicationTasks,
    jobs,
    documents,
    createDb: () => ({
      select: () => ({
        from: (table: unknown) => ({
          where: () => ({
            limit: async () => rowsFor(table),
            orderBy: () => ({ limit: async () => rowsFor(table) }),
          }),
        }),
      }),
    }),
  };
});

vi.mock('drizzle-orm', () => ({
  eq: (col: unknown, val: unknown) => ({ col, val }),
  and: (...conds: unknown[]) => conds,
  desc: (col: unknown) => col,
}));

vi.mock('@sower/storage', () => ({
  createStorage: () => ({
    get: async (path: string) => {
      state.storageGets.push(path);
      return state.imageBytes;
    },
  }),
}));

vi.mock('@sower/investigate', () => ({
  investigateScreenshot: async (input: {
    image: Buffer;
    contentType: string;
    hint?: string;
  }) => {
    state.investigateCalls.push(input);
    return state.outcome;
  },
}));

const fetchMock = vi.fn(
  async (): Promise<{
    ok: boolean;
    status: number;
    text: () => Promise<string>;
  }> => ({
    ok: true,
    status: 200,
    text: async () => '',
  }),
);

describe('investigator run()', () => {
  beforeEach(() => {
    state.taskRows = [{ id: 'task-1', jobId: 'job-1' }];
    state.jobRows = [{ id: 'job-1', company: 'Acme', title: 'SWE Intern' }];
    state.documentRows = [
      {
        id: 'doc-1',
        kind: 'screenshot',
        storagePath: 'documents/doc-1/shot.png',
        contentType: 'image/png',
      },
    ];
    state.storageGets = [];
    state.investigateCalls = [];
    fetchMock.mockClear();
    vi.stubGlobal('fetch', fetchMock);
    process.env.TASK_ID = 'task-1';
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-token';
    process.env.DATABASE_URL = 'postgres://test';
    process.env.API_BASE = 'https://api.example.com';
    process.env.INGEST_API_KEY = 'secret-key';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    for (const key of [
      'TASK_ID',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'DATABASE_URL',
      'API_BASE',
      'INGEST_API_KEY',
    ]) {
      delete process.env[key];
    }
  });

  it('fetches the screenshot and POSTs {result, transcript} to the API', async () => {
    const code = await run();
    expect(code).toBe(0);

    expect(state.storageGets).toEqual(['documents/doc-1/shot.png']);

    expect(state.investigateCalls).toHaveLength(1);
    const call = state.investigateCalls[0];
    expect(call?.image).toBe(state.imageBytes);
    expect(call?.contentType).toBe('image/png');
    expect(call?.hint).toBe('company: Acme; role title: SWE Intern');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      { method: string; headers: Record<string, string>; body: string },
    ];
    expect(url).toBe(
      'https://api.example.com/tasks/task-1/investigation-result',
    );
    expect(init.method).toBe('POST');
    expect(init.headers['x-api-key']).toBe('secret-key');
    expect(JSON.parse(init.body)).toEqual({
      result: state.outcome.result,
      transcript: state.outcome.transcript,
    });
  });

  it('exits 0 without doing anything when the token is missing', async () => {
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    const code = await run();
    expect(code).toBe(0);
    expect(state.investigateCalls).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('exits 0 when the job has no screenshot document', async () => {
    state.documentRows = [];
    const code = await run();
    expect(code).toBe(0);
    expect(state.investigateCalls).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('exits 1 when the POST fails', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => 'boom',
    });
    const code = await run();
    expect(code).toBe(1);
  });
});
