import { describe, expect, it } from 'vitest';
import { generatePassword } from './password.js';

describe('generatePassword', () => {
  it('produces the requested length (default 20)', () => {
    expect(generatePassword()).toHaveLength(20);
    expect(generatePassword(32)).toHaveLength(32);
  });

  it('always contains upper, lower, digit, and symbol', () => {
    for (let i = 0; i < 50; i++) {
      const pw = generatePassword();
      expect(pw).toMatch(/[A-Z]/);
      expect(pw).toMatch(/[a-z]/);
      expect(pw).toMatch(/[0-9]/);
      expect(pw).toMatch(/[!@#$%^&*()\-_=+[\]{}<>?]/);
    }
  });

  it('never contains ambiguous glyphs, quotes, backslash, or whitespace', () => {
    for (let i = 0; i < 50; i++) {
      const pw = generatePassword();
      expect(pw).not.toMatch(/[0O1lI"'`\\\s]/);
    }
  });

  it('is unique across calls', () => {
    const seen = new Set(Array.from({ length: 100 }, () => generatePassword()));
    expect(seen.size).toBe(100);
  });

  it('survives a JSON round-trip unchanged', () => {
    const pw = generatePassword();
    expect(JSON.parse(JSON.stringify({ pw })).pw).toBe(pw);
  });

  it('rejects lengths that are too short to hold all classes safely', () => {
    expect(() => generatePassword(8)).toThrow(/length must be >= 12/);
  });
});
