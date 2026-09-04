import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { booleanChoice, optionMatches } from './ashby-fill.js';

describe('booleanChoice', () => {
  it("reads the adapter's Boolean values and Yes/No labels", () => {
    expect(booleanChoice({ value: 'true', optionLabel: 'Yes' })).toBe('yes');
    expect(booleanChoice({ value: 'false', optionLabel: 'No' })).toBe('no');
    expect(booleanChoice({ value: 'No', optionLabel: null })).toBe('no');
  });

  it('refuses anything that is not a yes or a no', () => {
    expect(booleanChoice({ value: 'Maybe', optionLabel: 'Maybe' })).toBeNull();
  });
});

describe('optionMatches', () => {
  it('matches a row by the option label or the raw value', () => {
    expect(
      optionMatches('He/Him ', { value: '1', optionLabel: 'He/Him' }),
    ).toBe(true);
    expect(
      optionMatches('New York, NY', {
        value: 'New York, NY',
        optionLabel: null,
      }),
    ).toBe(true);
    expect(
      optionMatches('She/Her', { value: '1', optionLabel: 'He/Him' }),
    ).toBe(false);
  });
});

describe('executor safety', () => {
  // The same guardrail the greenhouse filler carries: nothing in this
  // module may send a form or drive the page-level keyboard.
  const source = readFileSync(
    new URL('./ashby-fill.ts', import.meta.url),
    'utf8',
  );

  it('contains no form-sending interaction', () => {
    expect(source).not.toMatch(/submit/i);
  });

  it('never uses the page-level keyboard or an Enter press', () => {
    expect(source).not.toMatch(/keyboard\.press/);
    expect(source).not.toMatch(/keyboard\.type/);
    expect(source).not.toMatch(/press\('Enter'/);
  });

  it('only clicks a question’s own yes/no pair, a radio label, or an option', () => {
    for (const line of source.split('\n')) {
      if (/\.click\(/.test(line)) {
        expect(line).not.toMatch(/submit|apply/i);
      }
    }
  });
});
