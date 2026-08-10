import { parseArgs } from 'node:util';
import { resolveConfig } from './config.js';

/**
 * The whole CLI surface: NON-INTERACTIVE by design — plain args in, JSON
 * out (one value on stdout), no prompts, no TTY assumptions, so agents can
 * drive it. Every command maps to exactly ONE api request; the injected io
 * (fetch included) keeps everything testable without a network.
 *
 * Contract:
 * - stdout: the result as compact JSON (--pretty: table-ish text)
 * - stderr: errors as ONE-LINE JSON ({error, status?})
 * - exit codes: 0 ok · 1 error (args/HTTP/network) · 2 not found (404)
 *   · 3 not configured (no token)
 * - the token is NEVER echoed anywhere
 */

export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_NOT_FOUND = 2;
export const EXIT_NOT_CONFIGURED = 3;

/** Requests abort after this long — agent commands must stay bounded. */
const TIMEOUT_MS = 30_000;

export interface CliIo {
  env: Record<string, string | undefined>;
  fetch: typeof fetch;
  stdout(line: string): void;
  stderr(line: string): void;
  /** Read a file (the auth config); throws when missing. */
  readFile(path: string): string;
  /** Write a file (`export --out`). */
  writeFile(path: string, content: string): void;
  /** Persist auth config (~/.config/sower/config.json, chmod 600). */
  writeAuth(update: { token: string; base?: string }): void;
}

class CliError extends Error {
  readonly exitCode: number;
  readonly status: number | undefined;

  constructor(message: string, exitCode: number, status?: number) {
    super(message);
    this.exitCode = exitCode;
    this.status = status;
  }
}

// Compact on purpose: agents read this. Keep it to one screen.
const HELP = `sower — non-interactive CLI over the sower api (JSON out)

usage: sower <command> [args] [--pretty]

auth
  auth set --token <t> [--base <url>]  save credentials (chmod 600); prints "ok"

read
  tasks [--state a,b] [--limit n]      all tasks, EVERY state incl. archive
                                       (states: INGESTED PARSED QUEUED PREPARING
                                       NEEDS_INPUT REVIEW AWAITING_OTP FILLING
                                       SUBMITTED CONFIRMED FAILED DUPLICATE DISCARDED)
  task <id>                            full detail: questions (incl. saved answers),
                                       followups, jobNotes, timeline
  questions <taskId>                   just the task's questions array
  notes <taskId>                       the task's job-notes
  followups [<taskId>]                 all open followups, or one task's followups
  followup <id>                        followup detail
  export [--state a,b] [--out f.json]  every task in full detail (file or stdout)

write
  notes add <taskId> --body <text> [--question <qid>]
  notes rm <taskId> <noteId>
  followup <id> --transition TRIAGE|SCHEDULE|COMPLETE_STEP|RESOLVE|DISMISS|REOPEN
  mark-applied <taskId> [--note <t>]
  discard <taskId> [--note <t>]

config: env SOWER_API_KEY / SOWER_API_BASE beat ~/.config/sower/config.json
errors: one-line JSON on stderr · exit 0 ok, 1 error, 2 not found, 3 not configured`;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One api round-trip; the ONLY place the token is used. */
async function request(
  io: CliIo,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<unknown> {
  const config = resolveConfig(io.env, io.readFile);
  if (config.token === null) {
    throw new CliError(
      'not configured: set SOWER_API_KEY (and SOWER_API_BASE), or run `sower auth set --token <token> [--base <url>]`',
      EXIT_NOT_CONFIGURED,
    );
  }
  let response: Response;
  try {
    response = await io.fetch(`${config.base}${path}`, {
      method,
      headers: {
        'x-api-key': config.token,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    // Network/timeout failure. The message never carries the token.
    throw new CliError(`request failed: ${errorMessage(error)}`, EXIT_ERROR);
  }
  const text = await response.text();
  let data: unknown = null;
  if (text !== '') {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!response.ok) {
    const detail =
      data !== null &&
      typeof data === 'object' &&
      typeof (data as { error?: unknown }).error === 'string'
        ? (data as { error: string }).error
        : `HTTP ${response.status}`;
    throw new CliError(
      detail,
      response.status === 404 ? EXIT_NOT_FOUND : EXIT_ERROR,
      response.status,
    );
  }
  return data;
}

/** ?key=value string from the defined entries (empty when none). */
function queryString(params: Record<string, string | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      search.set(key, value);
    }
  }
  const encoded = search.toString();
  return encoded === '' ? '' : `?${encoded}`;
}

function isFlat(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.values(value).every(
      (field) => field === null || typeof field !== 'object',
    )
  );
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) {
    return '-';
  }
  // Newlines would break row alignment; --pretty is a glance, JSON is data.
  return String(value).replace(/\s+/g, ' ');
}

/** Aligned columns for an array of flat same-shaped objects. */
function renderTable(rows: Record<string, unknown>[]): string {
  const columns = Object.keys(rows[0] ?? {});
  const widths = columns.map((column) =>
    Math.max(column.length, ...rows.map((row) => cellText(row[column]).length)),
  );
  const line = (cells: string[]) =>
    cells
      .map((cell, i) => cell.padEnd(widths[i] ?? 0))
      .join('  ')
      .trimEnd();
  return [
    line(columns),
    ...rows.map((row) => line(columns.map((column) => cellText(row[column])))),
  ].join('\n');
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n');
}

/** Table-ish text for --pretty; best-effort, never the machine surface. */
function renderPretty(value: unknown): string {
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return '(none)';
    }
    if (value.every(isFlat)) {
      return renderTable(value);
    }
    return value.map((item) => renderPretty(item)).join('\n\n');
  }
  if (value !== null && typeof value === 'object') {
    return Object.entries(value)
      .map(([key, field]) =>
        field !== null && typeof field === 'object'
          ? `${key}:\n${indent(renderPretty(field))}`
          : `${key}: ${cellText(field)}`,
      )
      .join('\n');
  }
  return cellText(value);
}

function parseCliArgs(argv: string[]) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      pretty: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
      state: { type: 'string' },
      limit: { type: 'string' },
      note: { type: 'string' },
      body: { type: 'string' },
      question: { type: 'string' },
      transition: { type: 'string' },
      out: { type: 'string' },
      token: { type: 'string' },
      base: { type: 'string' },
    },
  });
}

type ParsedArgs = ReturnType<typeof parseCliArgs>;

/** Positional at `index`, or a usage error naming what is missing. */
function need(positionals: string[], index: number, name: string): string {
  const value = positionals[index];
  if (value === undefined) {
    throw new CliError(`missing <${name}> — see sower --help`, EXIT_ERROR);
  }
  return value;
}

/** A field of an api response, without trusting the response's shape. */
function field(data: unknown, key: string): unknown {
  if (data !== null && typeof data === 'object') {
    return (data as Record<string, unknown>)[key];
  }
  return undefined;
}

async function dispatch(
  { values, positionals }: ParsedArgs,
  io: CliIo,
): Promise<number> {
  const emit = (value: unknown) => {
    io.stdout(
      values.pretty === true ? renderPretty(value) : JSON.stringify(value),
    );
  };
  const command = positionals[0];
  if (command === undefined || command === 'help' || values.help === true) {
    io.stdout(HELP);
    return EXIT_OK;
  }
  switch (command) {
    case 'auth': {
      if (positionals[1] !== 'set') {
        throw new CliError(
          'usage: sower auth set --token <t> [--base <url>]',
          EXIT_ERROR,
        );
      }
      const token = values.token;
      if (typeof token !== 'string' || token.trim() === '') {
        throw new CliError('--token is required', EXIT_ERROR);
      }
      io.writeAuth({
        token,
        ...(typeof values.base === 'string' ? { base: values.base } : {}),
      });
      // Nothing but "ok" — the token must never be echoed.
      io.stdout('ok');
      return EXIT_OK;
    }
    case 'tasks': {
      const data = await request(
        io,
        'GET',
        `/cli/tasks${queryString({ state: values.state, limit: values.limit })}`,
      );
      emit(field(data, 'tasks'));
      return EXIT_OK;
    }
    case 'task': {
      const id = need(positionals, 1, 'id');
      emit(await request(io, 'GET', `/cli/tasks/${id}`));
      return EXIT_OK;
    }
    case 'questions': {
      const id = need(positionals, 1, 'taskId');
      const data = await request(io, 'GET', `/cli/tasks/${id}`);
      emit(field(data, 'questions'));
      return EXIT_OK;
    }
    case 'notes': {
      if (positionals[1] === 'add') {
        const id = need(positionals, 2, 'taskId');
        const body = values.body;
        if (typeof body !== 'string' || body.trim() === '') {
          throw new CliError('--body is required', EXIT_ERROR);
        }
        const data = await request(io, 'POST', `/tasks/${id}/job-notes`, {
          body,
          ...(typeof values.question === 'string'
            ? { questionId: values.question }
            : {}),
        });
        emit(data);
        return EXIT_OK;
      }
      if (positionals[1] === 'rm') {
        const id = need(positionals, 2, 'taskId');
        const noteId = need(positionals, 3, 'noteId');
        emit(
          await request(
            io,
            'POST',
            `/tasks/${id}/job-notes/${noteId}/delete`,
            {},
          ),
        );
        return EXIT_OK;
      }
      const id = need(positionals, 1, 'taskId');
      const data = await request(io, 'GET', `/cli/tasks/${id}`);
      emit(field(data, 'jobNotes'));
      return EXIT_OK;
    }
    case 'followups': {
      const taskId = positionals[1];
      if (taskId === undefined) {
        // All open follow-ups = the overview's "In play" section.
        const data = await request(io, 'GET', '/mobile/overview');
        emit(field(data, 'inPlay'));
        return EXIT_OK;
      }
      const data = await request(io, 'GET', `/cli/tasks/${taskId}`);
      emit(field(data, 'followups'));
      return EXIT_OK;
    }
    case 'followup': {
      const id = need(positionals, 1, 'id');
      if (typeof values.transition === 'string') {
        emit(
          await request(io, 'POST', `/followups/${id}/transition`, {
            event: values.transition,
          }),
        );
        return EXIT_OK;
      }
      emit(await request(io, 'GET', `/followups/${id}`));
      return EXIT_OK;
    }
    case 'mark-applied':
    case 'discard': {
      const id = need(positionals, 1, 'taskId');
      const data = await request(
        io,
        'POST',
        `/tasks/${id}/${command}`,
        typeof values.note === 'string' ? { note: values.note } : undefined,
      );
      emit(data);
      return EXIT_OK;
    }
    case 'export': {
      const data = await request(
        io,
        'GET',
        `/cli/export${queryString({ state: values.state })}`,
      );
      if (typeof values.out === 'string') {
        io.writeFile(values.out, `${JSON.stringify(data, null, 2)}\n`);
        const tasks = field(data, 'tasks');
        emit({
          ok: true,
          path: values.out,
          tasks: Array.isArray(tasks) ? tasks.length : 0,
        });
        return EXIT_OK;
      }
      emit(data);
      return EXIT_OK;
    }
    default:
      throw new CliError(
        `unknown command '${command}' — see sower --help`,
        EXIT_ERROR,
      );
  }
}

export async function runCli(argv: string[], io: CliIo): Promise<number> {
  let parsed: ParsedArgs;
  try {
    parsed = parseCliArgs(argv);
  } catch (error) {
    // parseArgs' own message (unknown option etc.) — argument NAMES only,
    // never values, so a token passed on argv cannot leak through here.
    io.stderr(JSON.stringify({ error: errorMessage(error) }));
    return EXIT_ERROR;
  }
  try {
    return await dispatch(parsed, io);
  } catch (error) {
    if (error instanceof CliError) {
      io.stderr(
        JSON.stringify({
          error: error.message,
          ...(error.status !== undefined ? { status: error.status } : {}),
        }),
      );
      return error.exitCode;
    }
    io.stderr(JSON.stringify({ error: errorMessage(error) }));
    return EXIT_ERROR;
  }
}
