import { randomInt } from 'node:crypto';

/**
 * Character classes for generated candidate-account passwords. Workday's
 * default policy wants upper + lower + digit + special; ambiguous glyphs
 * (0/O, 1/l/I) are excluded so a password read off a screen during a manual
 * rescue can be retyped without guessing. The symbol set avoids quotes,
 * backslashes, and whitespace so the value survives JSON, shells, and the
 * occasional buggy form validator.
 */
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const LOWER = 'abcdefghjkmnpqrstuvwxyz';
const DIGITS = '23456789';
const SYMBOLS = '!@#$%^&*()-_=+[]{}<>?';
const ALL = UPPER + LOWER + DIGITS + SYMBOLS;

const MIN_LENGTH = 12;

/**
 * Generate a strong random password (CSPRNG) guaranteed to contain at least
 * one character from each class. Default length 20.
 */
export function generatePassword(length = 20): string {
  if (length < MIN_LENGTH) {
    throw new Error(`password length must be >= ${MIN_LENGTH}, got ${length}`);
  }
  // One guaranteed pick per class, the rest from the full alphabet…
  const chars = [
    UPPER[randomInt(UPPER.length)],
    LOWER[randomInt(LOWER.length)],
    DIGITS[randomInt(DIGITS.length)],
    SYMBOLS[randomInt(SYMBOLS.length)],
  ];
  while (chars.length < length) {
    chars.push(ALL[randomInt(ALL.length)]);
  }
  // …then a Fisher-Yates shuffle (CSPRNG-driven) so the guaranteed classes
  // don't sit at predictable positions.
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j] as string, chars[i] as string];
  }
  return chars.join('');
}
