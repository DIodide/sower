import { describe, expect, it } from 'vitest';
import {
  renderScratchpad,
  scratchpadPath,
  slugify,
} from './portfolio-scratchpad.js';

/**
 * The pure halves of the scratchpad mirror: the file renderer (delimiter
 * after EVERY note, terminator-line escaping, tied-question labels, the
 * empty file) and the path slug rules. The GET-sha→PUT mechanics are proven
 * through the route tests in job-notes.test.ts with a mocked fetch.
 */

describe('renderScratchpad', () => {
  it('renders no notes as the empty file (the mirror writes it, never deletes)', () => {
    expect(renderScratchpad([])).toBe('');
  });

  it('terminates a single untied note with a --end line', () => {
    expect(renderScratchpad([{ body: 'ask about the team' }])).toBe(
      'ask about the team\n--end\n',
    );
  });

  it('prefixes a tied note with Q: <label> and keeps multi-line bodies', () => {
    expect(
      renderScratchpad([
        {
          body: 'draft:\nI want to work here because…',
          questionLabel: 'Why do you want to work here?',
        },
      ]),
    ).toBe(
      'Q: Why do you want to work here?\ndraft:\nI want to work here because…\n--end\n',
    );
  });

  it('terminates EVERY note, the last included', () => {
    expect(
      renderScratchpad([
        { body: 'first' },
        { body: 'second', questionLabel: 'Q2' },
        { body: 'third' },
      ]),
    ).toBe('first\n--end\nQ: Q2\nsecond\n--end\nthird\n--end\n');
  });

  it('escapes a body line that IS the terminator (trimmed) so a note can never split itself', () => {
    expect(
      renderScratchpad([{ body: 'before\n--end\n  --end  \nafter' }]),
    ).toBe('before\n\\--end\n\\--end\nafter\n--end\n');
  });

  it('leaves lines that merely contain --end alone', () => {
    expect(renderScratchpad([{ body: 'the --end marker is special' }])).toBe(
      'the --end marker is special\n--end\n',
    );
  });
});

describe('slugify', () => {
  it('lowercases and collapses non-alphanumeric runs to single dashes', () => {
    expect(slugify('Akuna Capital', 'x')).toBe('akuna-capital');
    expect(slugify('SWE Intern — Summer 2027 (NYC)', 'x')).toBe(
      'swe-intern-summer-2027-nyc',
    );
  });

  it('trims leading/trailing dashes', () => {
    expect(slugify('  (Acme) ', 'x')).toBe('acme');
  });

  it('caps at 60 chars without leaving a dangling dash', () => {
    const slug = slugify(`${'a'.repeat(59)} tail`, 'x');
    expect(slug).toBe('a'.repeat(59));
    expect(slug.length).toBeLessThanOrEqual(60);
  });

  it('falls back when the input is empty or slugs away entirely', () => {
    expect(slugify(null, 'unknown-company')).toBe('unknown-company');
    expect(slugify(undefined, 'unknown-company')).toBe('unknown-company');
    expect(slugify('***', 'unknown-company')).toBe('unknown-company');
  });
});

describe('scratchpadPath', () => {
  it('builds the repo-relative path from company + title slugs', () => {
    expect(
      scratchpadPath(
        'Akuna Capital',
        'SWE Intern',
        'aaaaaaaa-0000-4000-8000-000000000001',
      ),
    ).toBe('private/jobs/akuna-capital/swe-intern/scratchpad.md');
  });

  it('falls back to unknown-company / task-<id prefix> when identity is missing', () => {
    expect(
      scratchpadPath(null, null, 'aaaaaaaa-0000-4000-8000-000000000001'),
    ).toBe('private/jobs/unknown-company/task-aaaaaaaa/scratchpad.md');
  });
});
