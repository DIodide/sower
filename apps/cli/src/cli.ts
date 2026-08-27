import { parseArgs } from 'node:util';
import { resolveConfig } from './config.js';
import {
  renderDescription,
  renderFollowupsTable,
  renderGeneric,
  renderNotes,
  renderQuestions,
  renderTaskSummary,
  renderTasksTable,
  terminalWidth,
} from './pretty.js';

/**
 * The whole CLI surface: NON-INTERACTIVE by design — plain args in, JSON
 * out (one value on stdout), no prompts, no TTY assumptions, so agents can
 * drive it. Every command maps to exactly ONE api request; the injected io
 * (fetch included) keeps everything testable without a network.
 *
 * Contract:
 * - stdout: the result as compact JSON (--pretty: curated text for an
 *   80–120 column terminal, see pretty.ts — never the machine surface)
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
  /** The tty width (process.stdout.columns); absent when not a tty. */
  columns?: number;
}

class CliError extends Error {
  readonly exitCode: number;
  readonly status: number | undefined;
  /** Structured detail from the api body (e.g. validation `issues`) —
   *  agents act on WHY, not just "invalid". */
  readonly issues: unknown;

  constructor(
    message: string,
    exitCode: number,
    status?: number,
    issues?: unknown,
  ) {
    super(message);
    this.exitCode = exitCode;
    this.status = status;
    this.issues = issues;
  }
}

// Compact on purpose: agents read this. One line per verb; the README's
// command reference is this text verbatim (cli.test.ts keeps them equal).
export const HELP = `sower — non-interactive CLI over the sower api (JSON out)

usage: sower <command> [args] [--pretty]

auth
  auth set --token <t> [--base <url>]  save credentials (chmod 600); prints "ok"

read
  tasks [--state a,b] [--search <text>] [--limit n]
                                       all tasks, EVERY state incl. archive
                                       (states: INGESTED PARSED QUEUED PREPARING
                                       NEEDS_INPUT REVIEW AWAITING_OTP FILLING
                                       SUBMITTED CONFIRMED FAILED DUPLICATE DISCARDED)
  task <id>                            full detail: questions (incl. saved answers),
                                       followups, jobNotes, timeline
  description <taskId>                 {description} — the job description markdown
                                       (--pretty prints it raw, in full)
  questions <taskId>                   just the task's questions array
  answers <taskId>                     every question, compact: id, label, type,
                                       required, status, value, saved
  answer <taskId> <questionId>         one question, same compact shape
  notes <taskId>                       the task's job-notes
  followups [<taskId>]                 all open followups, or one task's followups
  followup <id>                        followup detail
  export [--state a,b] [--out f.json]  every task in full detail (file or stdout)

write
  answer set <taskId> <questionId> --value <v> [--value <v2>…] [--global]
                                       save an answer to the bank: repeated --value =
                                       multiselect; select values are option values;
                                       file questions take a document id; text answers
                                       are saved for this company unless --global.
                                       Re-resolves and reports what is still missing;
                                       adapter tasks apply it on the next run (requeue)
  task edit <id> [--notes <t> | --clear-notes] [--priority=-1|0|1|2]
                 [--due YYYY-MM-DD | --clear-due]
  resolve <taskId>                     re-run answer resolution in place (discovered specs)
  requeue <taskId>                     re-process a NEEDS_INPUT / FAILED task
  restore <taskId>                     bring a DISCARDED task back (NEEDS_INPUT)
  unmark-applied <taskId>              undo an out-of-band mark-applied
  reingest <taskId>                    reset the task in place and re-run ingestion
  mark-applied <taskId> [--note <t>]
  discard <taskId> [--note <t>]
  ingest <url> [--source <s>]          ingest one job url (source defaults to "cli")
  ingest --paste <text>                ingest every url found in a text blob
  ingest --manual --company <c> --title <t> [--notes <t>] [--priority=n]
                                       record a job with no url
  notes add <taskId> --body <text> [--question <qid>]
  notes edit <taskId> <noteId> [--body <text>] [--question <qid> | --general]
  notes rm <taskId> <noteId>
  followup add <taskId> --kind <k> --title <t> [--url <u>] [--due YYYY-MM-DD] [--notes <t>]
                                       (kinds: assessment interview recruiter offer
                                       rejection other)
  followup <id> --edit [--title <t>] [--url <u>] [--due YYYY-MM-DD] [--notes <t>]
  followup <id> --transition TRIAGE|SCHEDULE|COMPLETE_STEP|RESOLVE|DISMISS|REOPEN

config: env SOWER_API_KEY / SOWER_API_BASE beat ~/.config/sower/config.json
errors: one-line JSON on stderr · exit 0 ok, 1 error, 2 not found, 3 not configured`;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type Method = 'GET' | 'POST' | 'PATCH';

/** One api round-trip; the ONLY place the token is used. */
async function request(
  io: CliIo,
  method: Method,
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
    const issues =
      data !== null && typeof data === 'object'
        ? (data as { issues?: unknown }).issues
        : undefined;
    throw new CliError(
      detail,
      response.status === 404 ? EXIT_NOT_FOUND : EXIT_ERROR,
      response.status,
      issues,
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

function parseCliArgs(argv: string[]) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      pretty: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
      state: { type: 'string' },
      search: { type: 'string' },
      limit: { type: 'string' },
      note: { type: 'string' },
      body: { type: 'string' },
      question: { type: 'string' },
      general: { type: 'boolean', default: false },
      transition: { type: 'string' },
      edit: { type: 'boolean', default: false },
      out: { type: 'string' },
      token: { type: 'string' },
      base: { type: 'string' },
      value: { type: 'string', multiple: true },
      global: { type: 'boolean', default: false },
      notes: { type: 'string' },
      'clear-notes': { type: 'boolean', default: false },
      priority: { type: 'string' },
      due: { type: 'string' },
      'clear-due': { type: 'boolean', default: false },
      kind: { type: 'string' },
      title: { type: 'string' },
      url: { type: 'string' },
      paste: { type: 'string' },
      manual: { type: 'boolean', default: false },
      company: { type: 'string' },
      source: { type: 'string' },
    },
  });
}

type ParsedArgs = ReturnType<typeof parseCliArgs>;
type Values = ParsedArgs['values'];

/** Positional at `index`, or a usage error naming what is missing. */
function need(positionals: string[], index: number, name: string): string {
  const value = positionals[index];
  if (value === undefined) {
    throw new CliError(`missing <${name}> — see sower --help`, EXIT_ERROR);
  }
  return value;
}

/** A non-blank string option, or a usage error naming the flag. */
function needOption(values: Values, name: keyof Values): string {
  const value = values[name];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new CliError(`--${name} is required`, EXIT_ERROR);
  }
  return value;
}

/** A string option when given (undefined otherwise). */
function optional(values: Values, name: keyof Values): string | undefined {
  const value = values[name];
  return typeof value === 'string' ? value : undefined;
}

/** `--priority` as the api's TaskPriority (use --priority=-1 for low). */
function parsePriority(raw: string): -1 | 0 | 1 | 2 {
  const value = Number(raw);
  if (value === -1 || value === 0 || value === 1 || value === 2) {
    return value;
  }
  throw new CliError(
    '--priority must be -1, 0, 1 or 2 (write --priority=-1 for low)',
    EXIT_ERROR,
  );
}

/** A field of an api response, without trusting the response's shape. */
function field(data: unknown, key: string): unknown {
  if (data !== null && typeof data === 'object') {
    return (data as Record<string, unknown>)[key];
  }
  return undefined;
}

/**
 * The compact answer view (`answers` / `answer`): the detail's question
 * summary reduced to what an agent needs to decide what to set next.
 */
function compactAnswer(question: unknown): Record<string, unknown> {
  const q =
    question !== null && typeof question === 'object'
      ? (question as Record<string, unknown>)
      : {};
  return {
    id: q.id ?? null,
    label: q.label ?? null,
    type: q.type ?? null,
    required: q.required === true,
    status: q.status ?? null,
    value: q.value ?? null,
    saved: Array.isArray(q.savedValues) ? q.savedValues : null,
    ...(typeof q.savedDocId === 'string' ? { savedDocId: q.savedDocId } : {}),
    // Raw values `answer set` must echo to keep a saved answer (display
    // `saved` above is option LABELS / filenames — not settable input).
    ...(Array.isArray(q.savedInput) ? { savedInput: q.savedInput } : {}),
    ...(q.limit !== undefined && q.limit !== null ? { limit: q.limit } : {}),
    ...(Array.isArray(q.options) && q.options.length > 0
      ? { options: q.options }
      : {}),
  };
}

/** The task's questions as compact answers (the detail is one request). */
async function fetchAnswers(io: CliIo, taskId: string): Promise<unknown[]> {
  const data = await request(io, 'GET', `/cli/tasks/${taskId}`);
  const questions = field(data, 'questions');
  return Array.isArray(questions) ? questions.map(compactAnswer) : [];
}

type Renderer = (value: unknown, width: number) => string;

async function dispatch(
  { values, positionals }: ParsedArgs,
  io: CliIo,
): Promise<number> {
  const width = terminalWidth(io.columns, io.env);
  const emit = (value: unknown, render: Renderer = renderGeneric) => {
    io.stdout(
      values.pretty === true ? render(value, width) : JSON.stringify(value),
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
        `/cli/tasks${queryString({
          state: values.state,
          q: values.search,
          limit: values.limit,
        })}`,
      );
      emit(field(data, 'tasks'), renderTasksTable);
      return EXIT_OK;
    }
    case 'task': {
      if (positionals[1] === 'edit') {
        const id = need(positionals, 2, 'id');
        const body: {
          notes?: string | null;
          priority?: -1 | 0 | 1 | 2;
          dueDate?: string | null;
        } = {};
        if (values['clear-notes'] === true) {
          body.notes = null;
        } else if (typeof values.notes === 'string') {
          body.notes = values.notes;
        }
        if (typeof values.priority === 'string') {
          body.priority = parsePriority(values.priority);
        }
        if (values['clear-due'] === true) {
          body.dueDate = null;
        } else if (typeof values.due === 'string') {
          body.dueDate = values.due;
        }
        if (Object.keys(body).length === 0) {
          throw new CliError(
            'nothing to edit: give --notes/--clear-notes, --priority, or --due/--clear-due',
            EXIT_ERROR,
          );
        }
        emit(await request(io, 'POST', `/tasks/${id}/meta`, body));
        return EXIT_OK;
      }
      const id = need(positionals, 1, 'id');
      emit(await request(io, 'GET', `/cli/tasks/${id}`), renderTaskSummary);
      return EXIT_OK;
    }
    case 'description': {
      const id = need(positionals, 1, 'taskId');
      const data = await request(io, 'GET', `/cli/tasks/${id}`);
      emit({ description: field(data, 'description') ?? null }, (value) =>
        renderDescription(value),
      );
      return EXIT_OK;
    }
    case 'questions': {
      const id = need(positionals, 1, 'taskId');
      const data = await request(io, 'GET', `/cli/tasks/${id}`);
      emit(field(data, 'questions'), renderQuestions);
      return EXIT_OK;
    }
    case 'answers': {
      const id = need(positionals, 1, 'taskId');
      emit(await fetchAnswers(io, id), renderQuestions);
      return EXIT_OK;
    }
    case 'answer': {
      if (positionals[1] === 'set') {
        const taskId = need(positionals, 2, 'taskId');
        const questionId = need(positionals, 3, 'questionId');
        const given = values.value ?? [];
        if (given.length === 0) {
          throw new CliError('--value is required', EXIT_ERROR);
        }
        // One --value = a scalar (text/select/file); several = multiselect.
        const value = given.length === 1 ? (given[0] ?? '') : given;
        emit(
          await request(io, 'POST', `/tasks/${taskId}/answers`, {
            answers: [
              {
                questionId,
                value,
                ...(values.global === true ? { scope: 'global' } : {}),
              },
            ],
          }),
        );
        return EXIT_OK;
      }
      const taskId = need(positionals, 1, 'taskId');
      const questionId = need(positionals, 2, 'questionId');
      const answers = await fetchAnswers(io, taskId);
      const answer = answers.find((a) => field(a, 'id') === questionId);
      if (answer === undefined) {
        throw new CliError(
          `question '${questionId}' is not a question of this task`,
          EXIT_NOT_FOUND,
        );
      }
      emit(answer, (value, w) => renderQuestions([value], w));
      return EXIT_OK;
    }
    case 'notes': {
      if (positionals[1] === 'add') {
        const id = need(positionals, 2, 'taskId');
        const body = needOption(values, 'body');
        const data = await request(io, 'POST', `/tasks/${id}/job-notes`, {
          body,
          ...(typeof values.question === 'string'
            ? { questionId: values.question }
            : {}),
        });
        emit(data);
        return EXIT_OK;
      }
      if (positionals[1] === 'edit') {
        const id = need(positionals, 2, 'taskId');
        const noteId = need(positionals, 3, 'noteId');
        const patch: { body?: string; questionId?: string | null } = {};
        if (typeof values.body === 'string') {
          patch.body = values.body;
        }
        if (values.general === true) {
          // Demote the note back to general: the api clears the tie on null.
          patch.questionId = null;
        } else if (typeof values.question === 'string') {
          patch.questionId = values.question;
        }
        if (Object.keys(patch).length === 0) {
          throw new CliError(
            'nothing to edit: give --body, --question <qid>, or --general',
            EXIT_ERROR,
          );
        }
        emit(
          await request(io, 'POST', `/tasks/${id}/job-notes/${noteId}`, patch),
        );
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
      emit(field(data, 'jobNotes'), renderNotes);
      return EXIT_OK;
    }
    case 'followups': {
      const taskId = positionals[1];
      if (taskId === undefined) {
        // All open follow-ups = the overview's "In play" section.
        const data = await request(io, 'GET', '/mobile/overview');
        emit(field(data, 'inPlay'), renderFollowupsTable);
        return EXIT_OK;
      }
      const data = await request(io, 'GET', `/cli/tasks/${taskId}`);
      emit(field(data, 'followups'), renderFollowupsTable);
      return EXIT_OK;
    }
    case 'followup': {
      if (positionals[1] === 'add') {
        const taskId = need(positionals, 2, 'taskId');
        const kind = needOption(values, 'kind');
        const title = needOption(values, 'title');
        emit(
          await request(io, 'POST', `/tasks/${taskId}/followups`, {
            kind,
            title,
            ...(typeof values.url === 'string' ? { url: values.url } : {}),
            ...(typeof values.due === 'string' ? { dueDate: values.due } : {}),
            ...(typeof values.notes === 'string'
              ? { notes: values.notes }
              : {}),
          }),
        );
        return EXIT_OK;
      }
      const id = need(positionals, 1, 'id');
      if (values.edit === true) {
        const patch: Record<string, string> = {};
        for (const [flag, key] of [
          ['title', 'title'],
          ['url', 'url'],
          ['due', 'dueDate'],
          ['notes', 'notes'],
        ] as const) {
          const value = optional(values, flag);
          if (value !== undefined) {
            patch[key] = value;
          }
        }
        if (Object.keys(patch).length === 0) {
          throw new CliError(
            'nothing to edit: give --title, --url, --due, or --notes',
            EXIT_ERROR,
          );
        }
        emit(await request(io, 'PATCH', `/followups/${id}`, patch));
        return EXIT_OK;
      }
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
    case 'resolve':
    case 'requeue':
    case 'restore':
    case 'unmark-applied':
    case 'reingest': {
      const id = need(positionals, 1, 'taskId');
      emit(await request(io, 'POST', `/tasks/${id}/${command}`));
      return EXIT_OK;
    }
    case 'ingest': {
      if (values.manual === true) {
        const company = needOption(values, 'company');
        const title = needOption(values, 'title');
        emit(
          await request(io, 'POST', '/ingest/manual', {
            company,
            title,
            ...(typeof values.notes === 'string'
              ? { notes: values.notes }
              : {}),
            ...(typeof values.priority === 'string'
              ? { priority: parsePriority(values.priority) }
              : {}),
          }),
        );
        return EXIT_OK;
      }
      if (typeof values.paste === 'string') {
        if (values.paste.trim() === '') {
          throw new CliError('--paste needs some text', EXIT_ERROR);
        }
        emit(
          await request(io, 'POST', '/ingest/paste', { text: values.paste }),
        );
        return EXIT_OK;
      }
      const url = need(positionals, 1, 'url');
      emit(
        await request(io, 'POST', '/ingest', {
          url,
          source: values.source ?? 'cli',
        }),
      );
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
          ...(error.issues !== undefined ? { issues: error.issues } : {}),
        }),
      );
      return error.exitCode;
    }
    io.stderr(JSON.stringify({ error: errorMessage(error) }));
    return EXIT_ERROR;
  }
}
