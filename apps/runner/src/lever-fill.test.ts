import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { optionMatches } from './lever-fill.js';

describe('optionMatches', () => {
  it('matches a radio or checkbox by its value or its text', () => {
    expect(optionMatches('Yes', { value: 'Yes', optionLabel: 'Yes' })).toBe(
      true,
    );
    expect(
      optionMatches(' English (ENG) ', {
        value: 'English (ENG)',
        optionLabel: null,
      }),
    ).toBe(true);
    expect(optionMatches('No', { value: 'Yes', optionLabel: 'Yes' })).toBe(
      false,
    );
  });
});

describe('executor safety', () => {
  const source = readFileSync(
    new URL('./lever-fill.ts', import.meta.url),
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

  it('only clicks a radio or checkbox label, a location result, or the location input', () => {
    for (const line of source.split('\n')) {
      if (/\.click\(/.test(line)) {
        expect(line).not.toMatch(/submit|apply|btn/i);
      }
    }
  });
});
