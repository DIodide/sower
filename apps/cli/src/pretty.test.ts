import { describe, expect, it } from 'vitest';
import {
  compactDate,
  planColumns,
  renderDescription,
  renderFollowupsTable,
  renderGeneric,
  renderQuestions,
  renderTaskSummary,
  renderTasksTable,
  taskColumns,
  terminalWidth,
  truncate,
  wrap,
} from './pretty.js';

/**
 * The --pretty layout as pure functions (no tty): column dropping and
 * flexible-column squeezing at 60/80/100/120 columns, ellipsis truncation
 * (a row never wraps, a line never exceeds the width), short ids, the
 * question blocks, the task summary's sections, and the width fallback.
 */

const NOW = new Date('2026-08-27T12:00:00.000Z');
const TASK_ID = 'aaaaaaaa-0000-4000-8000-000000000001';

function task(overrides: Record<string, unknown> = {}) {
  return {
    id: TASK_ID,
    company: 'Extremely Long Company Name Incorporated',
    title:
      'Software Engineering Intern, Distributed Systems Platform (Summer 2027)',
    state: 'NEEDS_INPUT',
    priority: 1,
    priorityLabel: 'High',
    dueDate: '2026-08-20T00:00:00.000Z',
    url: 'https://boards.greenhouse.io/acme/jobs/1',
    questionCount: 12,
    openFollowups: 2,
    ...overrides,
  };
}

const longestLine = (block: string) =>
  Math.max(...block.split('\n').map((line) => Array.from(line).length));

describe('planColumns / renderTasksTable', () => {
  const rows = [task(), task({ id: 'bbbbbbbb-0000-4000-8000-000000000002' })];

  it('at 120 every column shows, flexible columns grow up to their caps', () => {
    const layout = planColumns(rows, taskColumns(NOW), 120);
    expect(layout.map((slot) => slot.column.header)).toEqual([
      'id',
      'company',
      'title',
      'state',
      'prio',
      'due',
      'q',
      'fu',
    ]);
    const byHeader = new Map(layout.map((s) => [s.column.header, s.width]));
    expect(byHeader.get('title')).toBe(40);
    expect(byHeader.get('company')).toBe(20);
    expect(byHeader.get('id')).toBe(8);
    const table = renderTasksTable(rows, 120, NOW);
    expect(longestLine(table)).toBeLessThanOrEqual(120);
  });

  it('at 100 every column still shows, the text columns squeeze', () => {
    const layout = planColumns(rows, taskColumns(NOW), 100);
    expect(layout).toHaveLength(8);
    const byHeader = new Map(layout.map((s) => [s.column.header, s.width]));
    expect(byHeader.get('title')).toBeLessThan(40);
    expect(byHeader.get('title')).toBeGreaterThanOrEqual(23);
    const table = renderTasksTable(rows, 100, NOW);
    expect(longestLine(table)).toBeLessThanOrEqual(100);
    expect(longestLine(table)).toBeGreaterThan(90);
  });

  it('at 80 the lowest-priority column (open follow-ups) drops first', () => {
    const layout = planColumns(rows, taskColumns(NOW), 80);
    expect(layout.map((slot) => slot.column.header)).toEqual([
      'id',
      'company',
      'title',
      'state',
      'prio',
      'due',
      'q',
    ]);
    const table = renderTasksTable(rows, 80, NOW);
    expect(longestLine(table)).toBeLessThanOrEqual(80);
    for (const line of table.split('\n')) {
      expect(line).not.toContain('\n');
    }
  });

  it('at 60 only id · company · title · state survive', () => {
    const layout = planColumns(rows, taskColumns(NOW), 60);
    expect(layout.map((slot) => slot.column.header)).toEqual([
      'id',
      'company',
      'title',
      'state',
    ]);
    expect(longestLine(renderTasksTable(rows, 60, NOW))).toBeLessThanOrEqual(
      60,
    );
  });

  it('cells ellipsis-truncate and ids are shortened to 8 chars', () => {
    const table = renderTasksTable(rows, 80, NOW);
    const [header, first] = table.split('\n');
    expect(header?.startsWith('id        company')).toBe(true);
    expect(first?.startsWith('aaaaaaaa  ')).toBe(true);
    expect(first).not.toContain(TASK_ID);
    expect(first).toContain('…');
    expect(first).toContain('NEEDS_INPUT');
    expect(first).toContain('Aug 20');
  });

  it('short natural widths never pad to the floor; nothing → —', () => {
    const tiny = [
      task({
        company: 'Acme',
        title: 'SWE',
        dueDate: null,
        questionCount: 0,
        openFollowups: 0,
      }),
    ];
    const table = renderTasksTable(tiny, 120, NOW);
    expect(table.split('\n')[1]).toBe(
      'aaaaaaaa  Acme     SWE    NEEDS_INPUT  High  —    0   0',
    );
  });

  it('an empty list renders (none)', () => {
    expect(renderTasksTable([], 100, NOW)).toBe('(none)');
    expect(renderTasksTable(undefined, 100, NOW)).toBe('(none)');
  });
});

describe('renderFollowupsTable', () => {
  it('lays out id8 · kind · company · title · state · due within the width', () => {
    const rows = [
      {
        id: 'bbbbbbbb-0000-4000-8000-000000000001',
        taskId: TASK_ID,
        kind: 'assessment',
        kindLabel: 'Assessment',
        title: 'HackerRank online assessment — complete within 7 days please',
        state: 'ACTION_NEEDED',
        stateLabel: 'Action needed',
        dueDate: '2026-09-03T00:00:00.000Z',
        company: 'Acme',
      },
    ];
    const table = renderFollowupsTable(rows, 80, NOW);
    const [header, first] = table.split('\n');
    expect(header?.split(/\s{2,}/)).toEqual([
      'id',
      'kind',
      'company',
      'title',
      'state',
      'due',
    ]);
    expect(first?.startsWith('bbbbbbbb  assessment  Acme')).toBe(true);
    expect(first).toContain('ACTION_NEEDED');
    expect(first).toContain('Sep 3');
    expect(longestLine(table)).toBeLessThanOrEqual(80);
  });
});

describe('renderQuestions', () => {
  const questions = [
    {
      id: 'q-name',
      label: 'Full name',
      type: 'text',
      required: true,
      status: 'resolved',
      value: 'Ibraheem Amin',
      source: 'profile',
    },
    {
      id: 'q-cover',
      label: 'Cover letter',
      type: 'textarea',
      required: false,
      status: 'missing',
      value: null,
      source: null,
    },
    {
      id: 'q-why',
      label: 'Why here?',
      type: 'textarea',
      required: true,
      status: 'saved',
      value: null,
      source: null,
      savedValues: [
        'I have wanted to build distributed systems since my first internship, and your platform team ships exactly that kind of work at scale.',
      ],
    },
    {
      id: 'q-x',
      label: 'x'.repeat(600),
      type: 'text',
      required: false,
      status: 'unresolved',
      value: null,
      source: null,
    },
  ];

  it('one block per question: glyph, label, meta, then the wrapped value', () => {
    const out = renderQuestions(questions, 80);
    expect(out).toContain(
      '[✓] Full name (q-name, text, required)\n    → Ibraheem Amin [profile]',
    );
    expect(out).toContain(
      '[ ] Cover letter (q-cover, textarea)\n    → (no answer)',
    );
    expect(out).toContain(
      '[~] Why here? (q-why, textarea, required)\n    → (saved, applies on next run) I have',
    );
    expect(out).toContain('[?]');
    expect(out).toContain('(not resolved yet)');
    expect(longestLine(out)).toBeLessThanOrEqual(80);
    // The saved essay wrapped onto continuation lines, indented.
    expect(out).toMatch(/\n {6}\S/);
  });

  it('caps a label at 500 characters and accepts the compact `saved` shape', () => {
    const out = renderQuestions(questions, 120);
    // The overlong label hard-splits across indented continuation lines.
    expect(out.split('\n').some((line) => line.startsWith('[?]'))).toBe(true);
    const compact = renderQuestions(
      [{ id: 'q', label: 'Q', status: 'saved', saved: ['picked'] }],
      80,
    );
    expect(compact).toContain('(saved, applies on next run) picked');
    expect(renderQuestions([], 80)).toBe('(none)');
    // 600 x's + meta → ellipsis at the 500 mark, spread over wrapped lines.
    expect(out.replace(/\n {4}/g, '')).toContain(`${'x'.repeat(499)}…`);
  });
});

describe('renderTaskSummary', () => {
  const detail = {
    task: {
      id: TASK_ID,
      state: 'NEEDS_INPUT',
      priority: 1,
      priorityLabel: 'High',
      dueDate: '2026-08-20T00:00:00.000Z',
      notes: 'ping the recruiter',
      url: 'https://boards.greenhouse.io/acme/jobs/1',
      company: 'Acme',
      title: 'Software Engineer Intern',
    },
    description: Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join(
      '\n',
    ),
    questions: [
      { id: 'q1', label: 'Full name', status: 'resolved', value: 'Ib' },
      { id: 'q2', label: 'Cover letter', status: 'missing', value: null },
    ],
    jobNotes: [
      {
        id: 'dddddddd-0000-4000-8000-000000000001',
        body: 'They value TypeScript heavily.',
        questionId: 'q2',
        questionLabel: 'Cover letter',
        createdAt: '2026-07-02T12:00:00.000Z',
      },
    ],
    followups: [
      {
        id: 'bbbbbbbb-0000-4000-8000-000000000001',
        kind: 'recruiter',
        title: 'Recruiter reply',
        state: 'WAITING',
        dueDate: null,
        company: 'Acme',
      },
    ],
    timeline: Array.from({ length: 8 }, (_, i) => ({
      type: 'EVENT',
      at: `2026-08-0${8 - i}T12:00:00.000Z`,
      summary: `Event ${8 - i}`,
    })),
  };

  it('prints header, description (12 lines + more), questions, notes, follow-ups, last 5 timeline entries', () => {
    const out = renderTaskSummary(detail, 120, NOW);
    const lines = out.split('\n');
    expect(lines[0]).toBe('Acme — Software Engineer Intern');
    expect(lines[1]).toBe(
      `${TASK_ID} · NEEDS_INPUT · High · due Aug 20 · https://boards.greenhouse.io/acme/jobs/1`,
    );
    expect(lines[2]).toBe('notes: ping the recruiter');
    expect(out).toContain('\nDescription\n  line 1\n');
    expect(out).toContain('  line 12\n  … 8 more lines\n');
    expect(out).not.toContain('line 13');
    expect(out).toContain('Questions (2: 1 resolved · 1 missing · 0 saved)');
    expect(out).toContain('  [✓] Full name (q1)');
    expect(out).toContain(
      'Notes (1)\n  dddddddd · Jul 2 · re: Cover letter\n    They value TypeScript heavily.',
    );
    expect(out).toContain(
      'Follow-ups (1)\n  id        kind       company  title            state    due',
    );
    expect(out).toContain('Timeline (last 5)');
    expect(out).toContain('Aug 8  Event 8');
    expect(out).toContain('Aug 4  Event 4');
    expect(out).not.toContain('Event 3');
    expect(longestLine(out)).toBeLessThanOrEqual(120);
    // Narrower: the header line wraps instead of overflowing.
    expect(longestLine(renderTaskSummary(detail, 80, NOW))).toBeLessThanOrEqual(
      80,
    );
  });

  it('degrades gracefully on an empty detail', () => {
    const out = renderTaskSummary({}, 80, NOW);
    expect(out.split('\n')[0]).toBe('(untitled)');
    expect(out).toContain('Description\n  (none)');
    expect(out).toContain('Questions (none)');
    expect(out).toContain('Timeline (last 5)\n  (none)');
  });
});

describe('helpers', () => {
  it('compactDate: month + day, the year only when not this year, — for nothing', () => {
    expect(compactDate('2026-08-13T00:00:00.000Z', NOW)).toBe('Aug 13');
    expect(compactDate('2027-01-05T00:00:00.000Z', NOW)).toBe('Jan 5 2027');
    expect(compactDate(null, NOW)).toBe('—');
    expect(compactDate('nope', NOW)).toBe('—');
  });

  it('truncate keeps short text, ellipsizes long text at the width', () => {
    expect(truncate('abc', 5)).toBe('abc');
    expect(truncate('abcdefgh', 5)).toBe('abcd…');
    expect(truncate('abc', 1)).toBe('…');
  });

  it('wrap breaks on words, keeps paragraphs, splits overlong words', () => {
    expect(wrap('the quick brown fox', 9)).toEqual(['the quick', 'brown fox']);
    expect(wrap('a\n\nb', 10)).toEqual(['a', '', 'b']);
    expect(wrap('abcdefghij', 4)).toEqual(['abcd', 'efgh', 'ij']);
  });

  it('terminalWidth: tty columns, else $COLUMNS, else 100 — clamped', () => {
    expect(terminalWidth(132, {})).toBe(132);
    expect(terminalWidth(undefined, { COLUMNS: '90' })).toBe(90);
    expect(terminalWidth(undefined, { COLUMNS: 'wat' })).toBe(100);
    expect(terminalWidth(undefined, {})).toBe(100);
    expect(terminalWidth(10, {})).toBe(40);
    expect(terminalWidth(9000, {})).toBe(200);
  });

  it('renderDescription prints the markdown raw, (none) without one', () => {
    expect(renderDescription({ description: '# Role\n\n- a\n- b' })).toBe(
      '# Role\n\n- a\n- b',
    );
    expect(renderDescription({ description: null })).toBe('(none)');
  });

  it('renderGeneric: key/value with nested indent and wrapped long strings', () => {
    const out = renderGeneric(
      { ok: true, nested: { a: 1 }, long: 'word '.repeat(30).trim() },
      40,
    );
    expect(out).toContain('ok: true');
    expect(out).toContain('nested:\n  a: 1');
    expect(longestLine(out)).toBeLessThanOrEqual(40);
    expect(renderGeneric([{ a: 1, b: 'x' }], 40)).toBe('a  b\n1  x');
  });
});
