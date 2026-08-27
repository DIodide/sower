/**
 * `--pretty` renderers: what an agent (or a human) sees in an 80–120 column
 * terminal. Pure functions over the api's JSON — every accessor tolerates a
 * missing/odd field, and nothing here is the machine surface (that stays
 * the compact JSON on stdout). Tables are CURATED per command: each column
 * carries a priority so a narrow terminal drops the least important ones
 * first, flexible text columns squeeze between a floor and a cap, and cell
 * text ellipsis-truncates — a row NEVER wraps. Ids are shortened to their
 * first 8 characters in tables; the full ids stay in the JSON.
 */

export const DEFAULT_WIDTH = 100;
const MIN_WIDTH = 40;
const MAX_WIDTH = 200;
/** Two spaces between columns. */
const GAP = '  ';
/** Question labels are capped at this many characters in block views. */
const LABEL_MAX = 500;
/** `task --pretty` shows this many description lines before "… N more". */
const DESCRIPTION_LINES = 12;
/** `task --pretty` shows the newest N timeline entries. */
const TIMELINE_LINES = 5;

type Record_ = Record<string, unknown>;

/**
 * The terminal width to lay out for: the live tty width, else $COLUMNS,
 * else DEFAULT_WIDTH — clamped so a bogus value cannot produce a 3-column
 * or 3000-column layout.
 */
export function terminalWidth(
  columns: number | undefined,
  env: Record<string, string | undefined>,
): number {
  const fromEnv =
    env.COLUMNS !== undefined ? Number.parseInt(env.COLUMNS, 10) : Number.NaN;
  const width =
    columns !== undefined && Number.isFinite(columns) && columns > 0
      ? columns
      : Number.isFinite(fromEnv) && fromEnv > 0
        ? fromEnv
        : DEFAULT_WIDTH;
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, width));
}

function asRecord(value: unknown): Record_ {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record_)
    : {};
}

/** Display text for a scalar: '—' for nothing, whitespace collapsed. */
export function text(value: unknown): string {
  if (value === null || value === undefined || value === '') {
    return '—';
  }
  // Newlines would break row alignment; --pretty is a glance, JSON is data.
  return String(value).replace(/\s+/g, ' ').trim();
}

/** First 8 characters of an id (the uuid's first group). */
export function shortId(value: unknown): string {
  return typeof value === 'string' ? value.slice(0, 8) : '—';
}

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/**
 * `Aug 13` for an ISO date (the year is appended only when it is not the
 * current one); '—' for nothing/invalid. UTC parts: stored due dates are
 * UTC-midnight normalized, so local-time rendering could show the day
 * before.
 */
export function compactDate(value: unknown, now: Date = new Date()): string {
  if (typeof value !== 'string' || value === '') {
    return '—';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '—';
  }
  const label = `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}`;
  return date.getUTCFullYear() === now.getUTCFullYear()
    ? label
    : `${label} ${date.getUTCFullYear()}`;
}

/** Ellipsis-truncate to `width` code points. */
export function truncate(value: string, width: number): string {
  const points = Array.from(value);
  if (points.length <= width) {
    return value;
  }
  if (width <= 1) {
    return width === 1 ? '…' : '';
  }
  return `${points.slice(0, width - 1).join('')}…`;
}

function pad(value: string, width: number, align: 'left' | 'right'): string {
  const length = Array.from(value).length;
  const fill = ' '.repeat(Math.max(0, width - length));
  return align === 'right' ? `${fill}${value}` : `${value}${fill}`;
}

/** Greedy word wrap; paragraphs (newlines) are kept, long words split. */
export function wrap(value: string, width: number): string[] {
  const safeWidth = Math.max(1, width);
  const lines: string[] = [];
  for (const paragraph of value.split('\n')) {
    const words = paragraph.split(/\s+/).filter((word) => word !== '');
    if (words.length === 0) {
      lines.push('');
      continue;
    }
    let line = '';
    for (const word of words) {
      if (line === '') {
        line = word;
      } else if (line.length + 1 + word.length <= safeWidth) {
        line = `${line} ${word}`;
      } else {
        lines.push(line);
        line = word;
      }
      while (line.length > safeWidth) {
        lines.push(line.slice(0, safeWidth));
        line = line.slice(safeWidth);
      }
    }
    lines.push(line);
  }
  return lines;
}

function indent(block: string, by = '  '): string {
  return block
    .split('\n')
    .map((line) => (line === '' ? '' : `${by}${line}`))
    .join('\n');
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

export interface ColumnSpec<Row> {
  header: string;
  /** Higher survives longer as the terminal narrows. */
  priority: number;
  /**
   * Flexible text column: it may squeeze down to this width before the
   * layout starts dropping columns. Absent = fixed at its natural width.
   */
  min?: number;
  /** Cap on a flexible column's width; cells ellipsis-truncate beyond it. */
  max?: number;
  align?: 'left' | 'right';
  cell: (row: Row) => string;
}

export interface ColumnLayout<Row> {
  column: ColumnSpec<Row>;
  width: number;
}

/**
 * Fit columns into `width`: every column starts at its floor (its natural
 * width, or `min` for flexible ones); while the floors do not fit, the
 * LOWEST-priority column is dropped; the spare space then grows flexible
 * columns round-robin (highest priority first) up to their natural width.
 * Columns come back in their original order.
 */
export function planColumns<Row>(
  rows: Row[],
  columns: ColumnSpec<Row>[],
  width: number,
): ColumnLayout<Row>[] {
  const natural = columns.map((column) => {
    const longest = Math.max(
      column.header.length,
      ...rows.map((row) => Array.from(column.cell(row)).length),
    );
    return column.max === undefined ? longest : Math.min(longest, column.max);
  });
  const floor = columns.map((column, i) => {
    const naturalWidth = natural[i] ?? column.header.length;
    return column.min === undefined
      ? naturalWidth
      : Math.max(column.header.length, Math.min(column.min, naturalWidth));
  });
  let active = columns.map((_, i) => i);
  const total = (widths: number[]) =>
    active.reduce((sum, i) => sum + (widths[i] ?? 0), 0) +
    GAP.length * Math.max(0, active.length - 1);
  while (active.length > 1 && total(floor) > width) {
    let drop = active[0] ?? 0;
    for (const i of active) {
      if ((columns[i]?.priority ?? 0) < (columns[drop]?.priority ?? 0)) {
        drop = i;
      }
    }
    active = active.filter((i) => i !== drop);
  }
  const widths = [...floor];
  if (active.length === 1) {
    // A lone column still never overflows the terminal.
    const only = active[0] ?? 0;
    widths[only] = Math.min(widths[only] ?? width, width);
  }
  let spare = width - total(widths);
  const byPriority = [...active].sort(
    (a, b) => (columns[b]?.priority ?? 0) - (columns[a]?.priority ?? 0),
  );
  let grew = true;
  while (spare > 0 && grew) {
    grew = false;
    for (const i of byPriority) {
      if (spare > 0 && (widths[i] ?? 0) < (natural[i] ?? 0)) {
        widths[i] = (widths[i] ?? 0) + 1;
        spare -= 1;
        grew = true;
      }
    }
  }
  return active.flatMap((i) => {
    const column = columns[i];
    return column === undefined ? [] : [{ column, width: widths[i] ?? 0 }];
  });
}

/** Header + one line per row, laid out by planColumns; '(none)' when empty. */
export function renderTable<Row>(
  rows: Row[],
  columns: ColumnSpec<Row>[],
  width: number,
): string {
  if (rows.length === 0) {
    return '(none)';
  }
  const layout = planColumns(rows, columns, width);
  const line = (cells: string[]) =>
    layout
      .map((slot, i) =>
        pad(
          truncate(cells[i] ?? '', slot.width),
          slot.width,
          slot.column.align ?? 'left',
        ),
      )
      .join(GAP)
      .trimEnd();
  return [
    line(layout.map((slot) => slot.column.header)),
    ...rows.map((row) =>
      line(layout.map((slot) => text(slot.column.cell(row)))),
    ),
  ].join('\n');
}

function asRows(value: unknown): Record_[] {
  return Array.isArray(value) ? value.map(asRecord) : [];
}

/** `tasks --pretty`: id8 · company · title · state · prio · due · q · fu. */
export function taskColumns(now: Date): ColumnSpec<Record_>[] {
  return [
    { header: 'id', priority: 100, cell: (t) => shortId(t.id) },
    {
      header: 'company',
      priority: 70,
      min: 12,
      max: 20,
      cell: (t) => text(t.company),
    },
    {
      header: 'title',
      priority: 80,
      min: 23,
      max: 40,
      cell: (t) => text(t.title),
    },
    { header: 'state', priority: 90, cell: (t) => text(t.state) },
    { header: 'prio', priority: 60, cell: (t) => text(t.priorityLabel) },
    { header: 'due', priority: 65, cell: (t) => compactDate(t.dueDate, now) },
    {
      header: 'q',
      priority: 40,
      align: 'right',
      cell: (t) => text(t.questionCount),
    },
    {
      header: 'fu',
      priority: 30,
      align: 'right',
      cell: (t) => text(t.openFollowups),
    },
  ];
}

export function renderTasksTable(
  tasks: unknown,
  width: number,
  now: Date = new Date(),
): string {
  return renderTable(asRows(tasks), taskColumns(now), width);
}

/** `followups --pretty`: id8 · kind · company · title · state · due. */
export function followupColumns(now: Date): ColumnSpec<Record_>[] {
  return [
    { header: 'id', priority: 100, cell: (f) => shortId(f.id) },
    { header: 'kind', priority: 80, cell: (f) => text(f.kind) },
    {
      header: 'company',
      priority: 70,
      min: 10,
      max: 20,
      cell: (f) => text(f.company),
    },
    {
      header: 'title',
      priority: 90,
      min: 20,
      max: 40,
      cell: (f) => text(f.title),
    },
    { header: 'state', priority: 85, cell: (f) => text(f.state) },
    { header: 'due', priority: 75, cell: (f) => compactDate(f.dueDate, now) },
  ];
}

export function renderFollowupsTable(
  followups: unknown,
  width: number,
  now: Date = new Date(),
): string {
  return renderTable(asRows(followups), followupColumns(now), width);
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

function statusGlyph(status: unknown): string {
  switch (status) {
    case 'resolved':
      return '✓';
    case 'saved':
      return '~';
    case 'missing':
      return ' ';
    default:
      return '?';
  }
}

/** The line(s) after a question's label: its value, wrapped and indented. */
function questionValue(q: Record_): string {
  const status = q.status;
  if (status === 'resolved') {
    const source = typeof q.source === 'string' ? ` [${q.source}]` : '';
    return `${text(q.value)}${source}`;
  }
  if (status === 'saved') {
    const saved = Array.isArray(q.savedValues)
      ? q.savedValues
      : Array.isArray(q.saved)
        ? q.saved
        : [];
    const shown = saved.map((item) => text(item)).join(', ');
    return `(saved, applies on next run)${shown === '' ? '' : ` ${shown}`}`;
  }
  if (status === 'missing') {
    return '(no answer)';
  }
  return '(not resolved yet)';
}

/**
 * One block per question: `[glyph] label (id, type, required)` then the
 * value wrapped to the width under a `→`. Glyphs: ✓ resolved · ~ saved ·
 * ' ' missing · ? not resolved yet.
 */
export function renderQuestions(questions: unknown, width: number): string {
  const rows = asRows(questions);
  if (rows.length === 0) {
    return '(none)';
  }
  return rows
    .map((q) => {
      const meta = [
        typeof q.id === 'string' ? q.id : null,
        typeof q.type === 'string' ? q.type : null,
        q.required === true ? 'required' : null,
      ]
        .filter((part): part is string => part !== null)
        .join(', ');
      const label = truncate(text(q.label), LABEL_MAX);
      const head = `[${statusGlyph(q.status)}] ${label}${meta === '' ? '' : ` (${meta})`}`;
      // Continuation lines carry a 4-space indent, so wrap inside it.
      const headLines = wrap(head, Math.max(20, width - 4)).map((line, i) =>
        i === 0 ? line : `    ${line}`,
      );
      const valueLines = wrap(questionValue(q), Math.max(20, width - 6)).map(
        (line, i) => (i === 0 ? `    → ${line}` : `      ${line}`),
      );
      return [...headLines, ...valueLines].join('\n');
    })
    .join('\n');
}

/** `notes --pretty`: `id8 · date · re: question` then the wrapped body. */
export function renderNotes(
  notes: unknown,
  width: number,
  now: Date = new Date(),
): string {
  const rows = asRows(notes);
  if (rows.length === 0) {
    return '(none)';
  }
  return rows
    .map((note) => {
      const head = [
        shortId(note.id),
        compactDate(note.createdAt, now),
        typeof note.questionLabel === 'string'
          ? `re: ${truncate(text(note.questionLabel), 60)}`
          : null,
      ]
        .filter((part): part is string => part !== null)
        .join(' · ');
      const body =
        typeof note.body === 'string'
          ? wrap(note.body, Math.max(20, width - 2)).map((line) => `  ${line}`)
          : [];
      return [head, ...body].join('\n');
    })
    .join('\n');
}

/** `description --pretty`: the raw markdown, in full. */
export function renderDescription(detail: unknown): string {
  const description = asRecord(detail).description;
  return typeof description === 'string' && description !== ''
    ? description
    : '(none)';
}

/**
 * `task --pretty`: a sectioned summary — header (company — title; id,
 * state, priority, due, url; notes), Description (first lines + "… N more
 * lines"), Questions, Notes, Follow-ups, Timeline (newest N).
 */
export function renderTaskSummary(
  detail: unknown,
  width: number,
  now: Date = new Date(),
): string {
  const d = asRecord(detail);
  const task = asRecord(d.task);
  const lines: string[] = [];

  const identity = [task.company, task.title]
    .filter((part): part is string => typeof part === 'string' && part !== '')
    .join(' — ');
  lines.push(identity === '' ? '(untitled)' : truncate(identity, width));
  lines.push(
    ...wrap(
      [
        text(task.id),
        text(task.state),
        text(task.priorityLabel),
        `due ${compactDate(task.dueDate, now)}`,
        ...(typeof task.url === 'string' ? [task.url] : []),
      ].join(' · '),
      width,
    ),
  );
  if (typeof task.notes === 'string' && task.notes.trim() !== '') {
    lines.push(
      ...wrap(`notes: ${task.notes}`, Math.max(20, width - 2)).map((line, i) =>
        i === 0 ? line : `  ${line}`,
      ),
    );
  }

  lines.push('', 'Description');
  const description = d.description;
  if (typeof description !== 'string' || description.trim() === '') {
    lines.push('  (none)');
  } else {
    const all = description.split('\n');
    lines.push(
      ...all
        .slice(0, DESCRIPTION_LINES)
        .map((line) =>
          line === '' ? '' : `  ${truncate(line, Math.max(10, width - 2))}`,
        ),
    );
    if (all.length > DESCRIPTION_LINES) {
      lines.push(`  … ${all.length - DESCRIPTION_LINES} more lines`);
    }
  }

  const questions = asRows(d.questions);
  const tally = (status: string) =>
    questions.filter((q) => q.status === status).length;
  lines.push(
    '',
    questions.length === 0
      ? 'Questions (none)'
      : `Questions (${questions.length}: ${tally('resolved')} resolved · ${tally('missing')} missing · ${tally('saved')} saved)`,
  );
  if (questions.length > 0) {
    lines.push(indent(renderQuestions(questions, width - 2)));
  }

  const notes = asRows(d.jobNotes);
  lines.push('', `Notes (${notes.length})`);
  if (notes.length > 0) {
    lines.push(indent(renderNotes(notes, width - 2, now)));
  }

  const followups = asRows(d.followups);
  lines.push('', `Follow-ups (${followups.length})`);
  if (followups.length > 0) {
    lines.push(indent(renderFollowupsTable(followups, width - 2, now)));
  }

  const timeline = asRows(d.timeline).slice(0, TIMELINE_LINES);
  lines.push('', `Timeline (last ${TIMELINE_LINES})`);
  if (timeline.length === 0) {
    lines.push('  (none)');
  }
  for (const event of timeline) {
    lines.push(
      `  ${truncate(`${compactDate(event.at, now)}  ${text(event.summary ?? event.type)}`, Math.max(10, width - 2))}`,
    );
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Generic fallback
// ---------------------------------------------------------------------------

/**
 * Key/value text for anything without a curated view (write receipts,
 * followup detail, export): nested objects indent, arrays of flat objects
 * become a table of their own keys, long strings wrap.
 */
export function renderGeneric(value: unknown, width: number): string {
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return '(none)';
    }
    if (value.every(isFlat)) {
      const rows = value.map(asRecord);
      const keys = [...new Set(rows.flatMap((row) => Object.keys(row)))];
      return renderTable(
        rows,
        keys.map((key) => ({
          header: key,
          priority: 1,
          min: 8,
          max: 40,
          cell: (row: Record_) => text(row[key]),
        })),
        width,
      );
    }
    return value.map((item) => renderGeneric(item, width)).join('\n\n');
  }
  if (value !== null && typeof value === 'object') {
    return Object.entries(value)
      .map(([key, field]) => {
        if (field !== null && typeof field === 'object') {
          return `${key}:\n${indent(renderGeneric(field, width - 2))}`;
        }
        const shown = text(field);
        const head = `${key}: `;
        if (head.length + shown.length <= width) {
          return `${head}${shown}`;
        }
        return wrap(shown, Math.max(20, width - 2))
          .map((line, i) => (i === 0 ? `${head}\n  ${line}` : `  ${line}`))
          .join('\n');
      })
      .join('\n');
  }
  return text(value);
}

function isFlat(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.values(value).every(
      (field) => field === null || typeof field !== 'object',
    )
  );
}
