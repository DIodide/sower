import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { type CliIo, HELP, runCli } from './cli.js';

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

  it('--pretty renders a curated table (short ids, no JSON) at the io width', async () => {
    const tasks = [
      { id: TASK_ID, state: 'NEEDS_INPUT', company: 'Acme', title: 'SWE' },
      { id: NOTE_ID, state: 'REVIEW', company: null, title: null },
    ];
    const { io, out } = createIo([{ body: { tasks } }], { columns: 80 });
    await runCli(['tasks', '--pretty'], io);
    const text = out.join('\n');
    expect(text.split('\n')[0]?.startsWith('id        company')).toBe(true);
    expect(text).toContain('aaaaaaaa  Acme');
    expect(text).not.toContain(TASK_ID);
    expect(text).not.toContain('{');
    for (const line of text.split('\n')) {
      expect(line.length).toBeLessThanOrEqual(80);
    }
  });

  it('tasks --search adds ?q=', async () => {
    const { io, requests } = createIo([{ body: { tasks: [] } }]);
    await runCli(['tasks', '--search', 'acme corp', '--state', 'REVIEW'], io);
    expect(requests[0]?.url).toBe(`${BASE}/cli/tasks?state=REVIEW&q=acme+corp`);
  });

  it('description: GET the detail, print {description}; --pretty prints it raw', async () => {
    const detail = { task: { id: TASK_ID }, description: '# Role\n\n- a' };
    const json = createIo([{ body: detail }]);
    expect(await runCli(['description', TASK_ID], json.io)).toBe(0);
    expect(json.requests[0]?.url).toBe(`${BASE}/cli/tasks/${TASK_ID}`);
    expect(json.out).toEqual([
      JSON.stringify({ description: '# Role\n\n- a' }),
    ]);

    const pretty = createIo([{ body: detail }]);
    await runCli(['description', TASK_ID, '--pretty'], pretty.io);
    expect(pretty.out).toEqual(['# Role\n\n- a']);

    const none = createIo([{ body: { task: { id: TASK_ID } } }]);
    await runCli(['description', TASK_ID], none.io);
    expect(none.out).toEqual([JSON.stringify({ description: null })]);
  });

  it('answers: every question in the compact shape; answer picks one (exit 2 when absent)', async () => {
    const questions = [
      {
        id: 'q1',
        label: 'Full name',
        type: 'text',
        required: true,
        status: 'resolved',
        value: 'Ib',
        source: 'profile',
        limit: { kind: 'characters', max: 50 },
      },
      {
        id: 'q2',
        label: 'Resume',
        type: 'file',
        required: true,
        status: 'saved',
        value: null,
        source: null,
        savedValues: ['resume.pdf (resume)'],
        savedDocId: 'doc-1',
      },
    ];
    const all = createIo([{ body: { questions } }]);
    expect(await runCli(['answers', TASK_ID], all.io)).toBe(0);
    expect(all.requests[0]?.url).toBe(`${BASE}/cli/tasks/${TASK_ID}`);
    expect(JSON.parse(all.out[0] ?? '')).toEqual([
      {
        id: 'q1',
        label: 'Full name',
        type: 'text',
        required: true,
        status: 'resolved',
        value: 'Ib',
        saved: null,
      },
      {
        id: 'q2',
        label: 'Resume',
        type: 'file',
        required: true,
        status: 'saved',
        value: null,
        saved: ['resume.pdf (resume)'],
        savedDocId: 'doc-1',
      },
    ]);

    const one = createIo([{ body: { questions } }]);
    expect(await runCli(['answer', TASK_ID, 'q2'], one.io)).toBe(0);
    expect(JSON.parse(one.out[0] ?? '').id).toBe('q2');

    const missing = createIo([{ body: { questions } }]);
    expect(await runCli(['answer', TASK_ID, 'q9'], missing.io)).toBe(2);
    expect(missing.out).toEqual([]);
    expect(JSON.parse(missing.err[0] ?? '').error).toContain('q9');
  });
});

describe('write commands (new verbs)', () => {
  it('answer set: POST /tasks/:id/answers — one --value is a scalar, repeated is an array, --global scopes', async () => {
    const reply = {
      saved: 1,
      resolution: {
        resolved: 1,
        missing: 0,
        requiredMissing: 0,
        persisted: false,
      },
    };
    const scalar = createIo([{ body: reply }]);
    const code = await runCli(
      ['answer', 'set', TASK_ID, 'q1', '--value', 'Jane Doe'],
      scalar.io,
    );
    expect(code).toBe(0);
    expect(scalar.requests[0]?.method).toBe('POST');
    expect(scalar.requests[0]?.url).toBe(`${BASE}/tasks/${TASK_ID}/answers`);
    expect(JSON.parse(scalar.requests[0]?.body ?? '')).toEqual({
      answers: [{ questionId: 'q1', value: 'Jane Doe' }],
    });
    expect(scalar.out).toEqual([JSON.stringify(reply)]);

    const multi = createIo([{ body: reply }]);
    await runCli(
      [
        'answer',
        'set',
        TASK_ID,
        'q2',
        '--value',
        'ts',
        '--value',
        'rs',
        '--global',
      ],
      multi.io,
    );
    expect(JSON.parse(multi.requests[0]?.body ?? '')).toEqual({
      answers: [{ questionId: 'q2', value: ['ts', 'rs'], scope: 'global' }],
    });

    const none = createIo();
    expect(await runCli(['answer', 'set', TASK_ID, 'q1'], none.io)).toBe(1);
    expect(none.requests).toHaveLength(0);
  });

  it('task edit: POST /tasks/:id/meta with only the given fields; clears send null', async () => {
    const set = createIo([{ body: { ok: true } }]);
    const code = await runCli(
      [
        'task',
        'edit',
        TASK_ID,
        '--notes',
        'ping recruiter',
        '--priority=-1',
        '--due',
        '2026-09-01',
      ],
      set.io,
    );
    expect(code).toBe(0);
    expect(set.requests[0]?.method).toBe('POST');
    expect(set.requests[0]?.url).toBe(`${BASE}/tasks/${TASK_ID}/meta`);
    expect(JSON.parse(set.requests[0]?.body ?? '')).toEqual({
      notes: 'ping recruiter',
      priority: -1,
      dueDate: '2026-09-01',
    });

    const clear = createIo([{ body: { ok: true } }]);
    await runCli(
      ['task', 'edit', TASK_ID, '--clear-notes', '--clear-due'],
      clear.io,
    );
    expect(JSON.parse(clear.requests[0]?.body ?? '')).toEqual({
      notes: null,
      dueDate: null,
    });

    const only = createIo([{ body: { ok: true } }]);
    await runCli(['task', 'edit', TASK_ID, '--priority', '2'], only.io);
    expect(JSON.parse(only.requests[0]?.body ?? '')).toEqual({ priority: 2 });

    const nothing = createIo();
    expect(await runCli(['task', 'edit', TASK_ID], nothing.io)).toBe(1);
    expect(nothing.requests).toHaveLength(0);

    const bad = createIo();
    expect(
      await runCli(['task', 'edit', TASK_ID, '--priority', '5'], bad.io),
    ).toBe(1);
    expect(bad.requests).toHaveLength(0);
    expect(JSON.parse(bad.err[0] ?? '').error).toContain('--priority');
  });

  it('resolve / requeue / restore / unmark-applied / reingest: bare POST /tasks/:id/<verb>', async () => {
    for (const verb of [
      'resolve',
      'requeue',
      'restore',
      'unmark-applied',
      'reingest',
    ]) {
      const { io, requests, out } = createIo([{ body: { ok: true } }]);
      expect(await runCli([verb, TASK_ID], io)).toBe(0);
      expect(requests[0]?.method).toBe('POST');
      expect(requests[0]?.url).toBe(`${BASE}/tasks/${TASK_ID}/${verb}`);
      expect(requests[0]?.body).toBeNull();
      expect(out).toEqual([JSON.stringify({ ok: true })]);
    }
  });

  it('ingest: a url (source defaults to cli), --paste, --manual', async () => {
    const url = createIo([{ status: 201, body: { taskId: TASK_ID } }]);
    expect(
      await runCli(
        ['ingest', 'https://boards.greenhouse.io/acme/jobs/1'],
        url.io,
      ),
    ).toBe(0);
    expect(url.requests[0]?.url).toBe(`${BASE}/ingest`);
    expect(JSON.parse(url.requests[0]?.body ?? '')).toEqual({
      url: 'https://boards.greenhouse.io/acme/jobs/1',
      source: 'cli',
    });

    const sourced = createIo([{ status: 201, body: {} }]);
    await runCli(
      ['ingest', 'https://x.example/j', '--source', 'email'],
      sourced.io,
    );
    expect(JSON.parse(sourced.requests[0]?.body ?? '').source).toBe('email');

    const paste = createIo([{ body: { ok: true, urls: 2 } }]);
    await runCli(
      ['ingest', '--paste', 'see https://a.example and https://b.example'],
      paste.io,
    );
    expect(paste.requests[0]?.url).toBe(`${BASE}/ingest/paste`);
    expect(JSON.parse(paste.requests[0]?.body ?? '')).toEqual({
      text: 'see https://a.example and https://b.example',
    });

    const manual = createIo([
      { status: 201, body: { ok: true, taskId: TASK_ID } },
    ]);
    await runCli(
      [
        'ingest',
        '--manual',
        '--company',
        'Acme',
        '--title',
        'SWE Intern',
        '--notes',
        'met at fair',
        '--priority',
        '1',
      ],
      manual.io,
    );
    expect(manual.requests[0]?.url).toBe(`${BASE}/ingest/manual`);
    expect(JSON.parse(manual.requests[0]?.body ?? '')).toEqual({
      company: 'Acme',
      title: 'SWE Intern',
      notes: 'met at fair',
      priority: 1,
    });

    const noUrl = createIo();
    expect(await runCli(['ingest'], noUrl.io)).toBe(1);
    const noCompany = createIo();
    expect(
      await runCli(['ingest', '--manual', '--title', 'x'], noCompany.io),
    ).toBe(1);
    expect(noCompany.requests).toHaveLength(0);
  });

  it('notes edit: POST /tasks/:id/job-notes/:noteId with the patch; --general clears the tie', async () => {
    const tie = createIo([{ body: { note: { id: NOTE_ID } } }]);
    const code = await runCli(
      [
        'notes',
        'edit',
        TASK_ID,
        NOTE_ID,
        '--body',
        'Updated.',
        '--question',
        'q1',
      ],
      tie.io,
    );
    expect(code).toBe(0);
    expect(tie.requests[0]?.method).toBe('POST');
    expect(tie.requests[0]?.url).toBe(
      `${BASE}/tasks/${TASK_ID}/job-notes/${NOTE_ID}`,
    );
    expect(JSON.parse(tie.requests[0]?.body ?? '')).toEqual({
      body: 'Updated.',
      questionId: 'q1',
    });

    const general = createIo([{ body: { note: { id: NOTE_ID } } }]);
    await runCli(['notes', 'edit', TASK_ID, NOTE_ID, '--general'], general.io);
    expect(JSON.parse(general.requests[0]?.body ?? '')).toEqual({
      questionId: null,
    });

    const nothing = createIo();
    expect(await runCli(['notes', 'edit', TASK_ID, NOTE_ID], nothing.io)).toBe(
      1,
    );
    expect(nothing.requests).toHaveLength(0);
  });

  it('followup add: POST /tasks/:taskId/followups; followup --edit: PATCH /followups/:id', async () => {
    const add = createIo([{ body: { followup: { id: FOLLOWUP_ID } } }]);
    const code = await runCli(
      [
        'followup',
        'add',
        TASK_ID,
        '--kind',
        'assessment',
        '--title',
        'HackerRank',
        '--url',
        'https://hr.example/x',
        '--due',
        '2026-09-03',
        '--notes',
        '90 minutes',
      ],
      add.io,
    );
    expect(code).toBe(0);
    expect(add.requests[0]?.method).toBe('POST');
    expect(add.requests[0]?.url).toBe(`${BASE}/tasks/${TASK_ID}/followups`);
    expect(JSON.parse(add.requests[0]?.body ?? '')).toEqual({
      kind: 'assessment',
      title: 'HackerRank',
      url: 'https://hr.example/x',
      dueDate: '2026-09-03',
      notes: '90 minutes',
    });

    const edit = createIo([{ body: { followup: { id: FOLLOWUP_ID } } }]);
    await runCli(
      [
        'followup',
        FOLLOWUP_ID,
        '--edit',
        '--title',
        'Renamed',
        '--due',
        '2026-09-10',
      ],
      edit.io,
    );
    expect(edit.requests[0]?.method).toBe('PATCH');
    expect(edit.requests[0]?.url).toBe(`${BASE}/followups/${FOLLOWUP_ID}`);
    expect(JSON.parse(edit.requests[0]?.body ?? '')).toEqual({
      title: 'Renamed',
      dueDate: '2026-09-10',
    });

    const missingKind = createIo();
    expect(
      await runCli(
        ['followup', 'add', TASK_ID, '--title', 'x'],
        missingKind.io,
      ),
    ).toBe(1);
    const emptyEdit = createIo();
    expect(
      await runCli(['followup', FOLLOWUP_ID, '--edit'], emptyEdit.io),
    ).toBe(1);
    expect(emptyEdit.requests).toHaveLength(0);
  });

  it('the README carries --help verbatim (agents read both)', () => {
    const readme = readFileSync(
      new URL('../README.md', import.meta.url),
      'utf8',
    );
    expect(readme).toContain(HELP);
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

describe('answer view + api issues passthrough', () => {
  it('compact answers carry savedInput, limit, and select options when present', async () => {
    const detail = {
      questions: [
        {
          id: 'q1',
          label: 'Essay',
          type: 'textarea',
          required: false,
          status: 'saved',
          value: null,
          savedValues: ['Hello world'],
          savedInput: ['Hello world'],
          limit: { kind: 'characters', max: 500 },
        },
        {
          id: 'q2',
          label: 'Pick',
          type: 'select',
          required: true,
          status: 'missing',
          value: null,
          options: [{ label: 'Yes', value: 'y' }],
        },
      ],
    };
    const first = createIo([{ body: detail }]);
    expect(await runCli(['answer', TASK_ID, 'q1'], first.io)).toBe(0);
    const one = JSON.parse(first.out.join(''));
    expect(one.savedInput).toEqual(['Hello world']);
    expect(one.limit).toEqual({ kind: 'characters', max: 500 });
    const second = createIo([{ body: detail }]);
    expect(await runCli(['answer', TASK_ID, 'q2'], second.io)).toBe(0);
    expect(JSON.parse(second.out.join('')).options).toEqual([
      { label: 'Yes', value: 'y' },
    ]);
  });

  it('surfaces the api validation issues on stderr', async () => {
    const { io, err } = createIo([
      {
        status: 400,
        body: {
          error: 'invalid answers',
          issues: [{ questionId: 'q1', label: 'Essay', message: 'too long' }],
        },
      },
    ]);
    expect(
      await runCli(['answer', 'set', TASK_ID, 'q1', '--value', 'x'], io),
    ).toBe(1);
    const parsed = JSON.parse(err.join(''));
    expect(parsed.status).toBe(400);
    expect(parsed.issues).toEqual([
      { questionId: 'q1', label: 'Essay', message: 'too long' },
    ]);
  });
});
