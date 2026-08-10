import { describe, expect, it } from 'vitest';
import { type CliIo, runCli } from './cli.js';

/**
 * Command → request mapping with an injected fetch (no network), output
 * contracts (JSON on stdout, one-line JSON errors on stderr, exit codes),
 * and the token-hygiene rule: the token travels ONLY in the x-api-key
 * header, never into any output.
 */

const TOKEN = 'secret-token-abc';
const BASE = 'https://api.example.test';
const TASK_ID = 'aaaaaaaa-0000-4000-8000-000000000001';
const NOTE_ID = 'dddddddd-0000-4000-8000-000000000001';
const FOLLOWUP_ID = 'bbbbbbbb-0000-4000-8000-000000000001';

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

function createIo(
  responses: { status?: number; body?: unknown }[] = [],
  overrides: Partial<CliIo> = {},
) {
  const requests: Recorded[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const files: Record<string, string> = {};
  const auth: { token: string; base?: string }[] = [];
  const queue = [...responses];
  const io: CliIo = {
    env: { SOWER_API_KEY: TOKEN, SOWER_API_BASE: BASE },
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({
        url: String(input),
        method: init?.method ?? 'GET',
        headers: { ...((init?.headers ?? {}) as Record<string, string>) },
        body: typeof init?.body === 'string' ? init.body : null,
      });
      const next = queue.shift() ?? { body: {} };
      return new Response(JSON.stringify(next.body ?? {}), {
        status: next.status ?? 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch,
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    readFile: () => {
      throw new Error('ENOENT');
    },
    writeFile: (path, content) => {
      files[path] = content;
    },
    writeAuth: (update) => auth.push(update),
    ...overrides,
  };
  return { io, requests, out, err, files, auth };
}

describe('read commands', () => {
  it('tasks: GET /cli/tasks with state+limit, unwrapped to the array', async () => {
    const tasks = [{ id: TASK_ID, state: 'NEEDS_INPUT' }];
    const { io, requests, out } = createIo([{ body: { tasks } }]);
    const code = await runCli(
      ['tasks', '--state', 'NEEDS_INPUT,REVIEW', '--limit', '10'],
      io,
    );
    expect(code).toBe(0);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe('GET');
    expect(requests[0]?.url).toBe(
      `${BASE}/cli/tasks?state=NEEDS_INPUT%2CREVIEW&limit=10`,
    );
    expect(requests[0]?.headers['x-api-key']).toBe(TOKEN);
    expect(out).toEqual([JSON.stringify(tasks)]);
  });

  it('tasks: no flags means no query string', async () => {
    const { io, requests } = createIo([{ body: { tasks: [] } }]);
    await runCli(['tasks'], io);
    expect(requests[0]?.url).toBe(`${BASE}/cli/tasks`);
  });

  it('task: GET /cli/tasks/:id prints the whole detail', async () => {
    const detail = { task: { id: TASK_ID }, questions: [] };
    const { io, requests, out } = createIo([{ body: detail }]);
    const code = await runCli(['task', TASK_ID], io);
    expect(code).toBe(0);
    expect(requests[0]?.url).toBe(`${BASE}/cli/tasks/${TASK_ID}`);
    expect(out).toEqual([JSON.stringify(detail)]);
  });

  it('questions/notes: fetch the detail, print only their array', async () => {
    const questions = [{ id: 'q1', status: 'missing' }];
    const jobNotes = [{ id: NOTE_ID, body: 'hi' }];
    const first = createIo([{ body: { questions, jobNotes } }]);
    await runCli(['questions', TASK_ID], first.io);
    expect(first.out).toEqual([JSON.stringify(questions)]);

    const second = createIo([{ body: { questions, jobNotes } }]);
    await runCli(['notes', TASK_ID], second.io);
    expect(second.out).toEqual([JSON.stringify(jobNotes)]);
  });

  it('followups: overview inPlay without a task, the task detail with one', async () => {
    const inPlay = [{ id: FOLLOWUP_ID, state: 'ACTION_NEEDED' }];
    const all = createIo([{ body: { inPlay } }]);
    await runCli(['followups'], all.io);
    expect(all.requests[0]?.url).toBe(`${BASE}/mobile/overview`);
    expect(all.out).toEqual([JSON.stringify(inPlay)]);

    const followups = [{ id: FOLLOWUP_ID, state: 'WAITING' }];
    const one = createIo([{ body: { followups } }]);
    await runCli(['followups', TASK_ID], one.io);
    expect(one.requests[0]?.url).toBe(`${BASE}/cli/tasks/${TASK_ID}`);
    expect(one.out).toEqual([JSON.stringify(followups)]);
  });

  it('followup: GET /followups/:id', async () => {
    const body = { followup: { id: FOLLOWUP_ID }, task: { id: TASK_ID } };
    const { io, requests, out } = createIo([{ body }]);
    const code = await runCli(['followup', FOLLOWUP_ID], io);
    expect(code).toBe(0);
    expect(requests[0]?.url).toBe(`${BASE}/followups/${FOLLOWUP_ID}`);
    expect(out).toEqual([JSON.stringify(body)]);
  });

  it('--pretty renders a table, not JSON', async () => {
    const tasks = [
      { id: TASK_ID, state: 'NEEDS_INPUT', company: 'Acme' },
      { id: NOTE_ID, state: 'REVIEW', company: null },
    ];
    const { io, out } = createIo([{ body: { tasks } }]);
    await runCli(['tasks', '--pretty'], io);
    const text = out.join('\n');
    expect(text).toContain('id');
    expect(text).toContain('Acme');
    expect(text).not.toContain('{');
  });
});

describe('write commands', () => {
  it('notes add: POST /tasks/:id/job-notes with body and question tie', async () => {
    const response = { note: { id: NOTE_ID }, sync: { status: 'skipped' } };
    const { io, requests, out } = createIo([{ body: response }]);
    const code = await runCli(
      ['notes', 'add', TASK_ID, '--body', 'They use Go.', '--question', 'q1'],
      io,
    );
    expect(code).toBe(0);
    expect(requests[0]?.method).toBe('POST');
    expect(requests[0]?.url).toBe(`${BASE}/tasks/${TASK_ID}/job-notes`);
    expect(requests[0]?.headers['content-type']).toBe('application/json');
    expect(JSON.parse(requests[0]?.body ?? '')).toEqual({
      body: 'They use Go.',
      questionId: 'q1',
    });
    expect(out).toEqual([JSON.stringify(response)]);
  });

  it('notes add without --body is a usage error', async () => {
    const { io, requests, err } = createIo();
    const code = await runCli(['notes', 'add', TASK_ID], io);
    expect(code).toBe(1);
    expect(requests).toHaveLength(0);
    expect(JSON.parse(err[0] ?? '')).toEqual({ error: '--body is required' });
  });

  it('notes rm: POST the delete route', async () => {
    const { io, requests } = createIo([{ body: { ok: true } }]);
    const code = await runCli(['notes', 'rm', TASK_ID, NOTE_ID], io);
    expect(code).toBe(0);
    expect(requests[0]?.method).toBe('POST');
    expect(requests[0]?.url).toBe(
      `${BASE}/tasks/${TASK_ID}/job-notes/${NOTE_ID}/delete`,
    );
  });

  it('followup --transition: POST the transition event', async () => {
    const { io, requests } = createIo([{ body: { followup: {} } }]);
    const code = await runCli(
      ['followup', FOLLOWUP_ID, '--transition', 'DISMISS'],
      io,
    );
    expect(code).toBe(0);
    expect(requests[0]?.method).toBe('POST');
    expect(requests[0]?.url).toBe(
      `${BASE}/followups/${FOLLOWUP_ID}/transition`,
    );
    expect(JSON.parse(requests[0]?.body ?? '')).toEqual({ event: 'DISMISS' });
  });

  it('mark-applied sends the note; discard without one sends no body', async () => {
    const marked = createIo([{ body: { status: 'submitted' } }]);
    await runCli(['mark-applied', TASK_ID, '--note', 'via portal'], marked.io);
    expect(marked.requests[0]?.url).toBe(
      `${BASE}/tasks/${TASK_ID}/mark-applied`,
    );
    expect(JSON.parse(marked.requests[0]?.body ?? '')).toEqual({
      note: 'via portal',
    });

    const discarded = createIo([{ body: { status: 'discarded' } }]);
    await runCli(['discard', TASK_ID], discarded.io);
    expect(discarded.requests[0]?.url).toBe(`${BASE}/tasks/${TASK_ID}/discard`);
    expect(discarded.requests[0]?.body).toBeNull();
  });
});

describe('export', () => {
  it('prints the full export to stdout by default', async () => {
    const body = { generatedAt: 'now', tasks: [{ task: { id: TASK_ID } }] };
    const { io, requests, out } = createIo([{ body }]);
    const code = await runCli(['export', '--state', 'SUBMITTED'], io);
    expect(code).toBe(0);
    expect(requests[0]?.url).toBe(`${BASE}/cli/export?state=SUBMITTED`);
    expect(out).toEqual([JSON.stringify(body)]);
  });

  it('--out writes the file and prints a small receipt', async () => {
    const body = { generatedAt: 'now', tasks: [{}, {}] };
    const { io, out, files } = createIo([{ body }]);
    const code = await runCli(['export', '--out', '/tmp/x.json'], io);
    expect(code).toBe(0);
    expect(JSON.parse(files['/tmp/x.json'] ?? '')).toEqual(body);
    expect(JSON.parse(out[0] ?? '')).toEqual({
      ok: true,
      path: '/tmp/x.json',
      tasks: 2,
    });
  });
});

describe('auth', () => {
  it('auth set persists and prints nothing but ok', async () => {
    const { io, requests, out, err, auth } = createIo();
    const code = await runCli(
      ['auth', 'set', '--token', TOKEN, '--base', 'https://x.example'],
      io,
    );
    expect(code).toBe(0);
    expect(requests).toHaveLength(0);
    expect(auth).toEqual([{ token: TOKEN, base: 'https://x.example' }]);
    expect(out).toEqual(['ok']);
    expect(err).toEqual([]);
  });

  it('auth set without --token is a usage error', async () => {
    const { io, auth } = createIo();
    const code = await runCli(['auth', 'set'], io);
    expect(code).toBe(1);
    expect(auth).toEqual([]);
  });
});

describe('errors and exit codes', () => {
  it('404 exits 2 with the api error on stderr', async () => {
    const { io, out, err } = createIo([
      { status: 404, body: { error: 'task not found' } },
    ]);
    const code = await runCli(['task', TASK_ID], io);
    expect(code).toBe(2);
    expect(out).toEqual([]);
    expect(err).toHaveLength(1);
    expect(JSON.parse(err[0] ?? '')).toEqual({
      error: 'task not found',
      status: 404,
    });
  });

  it('other HTTP failures exit 1', async () => {
    const { io, err } = createIo([{ status: 500, body: { error: 'boom' } }]);
    const code = await runCli(['tasks'], io);
    expect(code).toBe(1);
    expect(JSON.parse(err[0] ?? '')).toEqual({ error: 'boom', status: 500 });
  });

  it('no token anywhere exits 3 without touching the network', async () => {
    const { io, requests, err } = createIo([], { env: {} });
    const code = await runCli(['tasks'], io);
    expect(code).toBe(3);
    expect(requests).toHaveLength(0);
    expect(JSON.parse(err[0] ?? '').error).toContain('not configured');
  });

  it('unknown commands and unknown options exit 1 with one-line JSON', async () => {
    const unknown = createIo();
    expect(await runCli(['frobnicate'], unknown.io)).toBe(1);
    expect(JSON.parse(unknown.err[0] ?? '').error).toContain('frobnicate');

    const badFlag = createIo();
    expect(await runCli(['tasks', '--nope'], badFlag.io)).toBe(1);
    expect(badFlag.err).toHaveLength(1);
    expect(() => JSON.parse(badFlag.err[0] ?? '')).not.toThrow();
  });

  it('--help prints the reference without a request', async () => {
    const { io, requests, out } = createIo();
    const code = await runCli(['--help'], io);
    expect(code).toBe(0);
    expect(requests).toHaveLength(0);
    expect(out.join('\n')).toContain('mark-applied');
  });
});

describe('token hygiene', () => {
  it('the token never appears in stdout or stderr, only in the header', async () => {
    const runs = [
      ['--help'],
      ['tasks'],
      ['task', TASK_ID],
      ['auth', 'set', '--token', TOKEN],
      ['tasks', '--bad-flag'],
    ];
    for (const argv of runs) {
      const { io, out, err } = createIo([
        { status: 500, body: { error: 'boom' } },
      ]);
      await runCli(argv, io);
      const everything = [...out, ...err].join('\n');
      expect(everything).not.toContain(TOKEN);
    }
  });
});
