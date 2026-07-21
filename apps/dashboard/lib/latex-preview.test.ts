import { describe, expect, it } from 'vitest';
import { firstLatexError, pdfBytesFromBase64 } from './latex-preview';

const TECTONIC_LOG = [
  'Running TeX ...',
  'This is XeTeX, Version 3.141592653',
  '(./resume.tex',
  '! Undefined control sequence.',
  'l.42 \\badmacro',
  '! Emergency stop.',
  'error: halted on potentially-recoverable error as specified',
].join('\n');

describe('firstLatexError', () => {
  it('returns the first !-prefixed line, not later ones', () => {
    expect(firstLatexError(TECTONIC_LOG)).toBe('! Undefined control sequence.');
  });

  it('tolerates CRLF line endings and leading whitespace', () => {
    expect(firstLatexError('noise\r\n  ! Missing $ inserted.\r\nmore')).toBe(
      '! Missing $ inserted.',
    );
  });

  it('returns null when the log has no !-prefixed line', () => {
    expect(firstLatexError('warning: something\nall fine')).toBeNull();
    expect(firstLatexError('')).toBeNull();
  });
});

describe('pdfBytesFromBase64', () => {
  it('round-trips bytes through base64', () => {
    const original = '%PDF-1.7 hello';
    const bytes = pdfBytesFromBase64(btoa(original));
    expect(String.fromCharCode(...bytes)).toBe(original);
  });

  it('ignores whitespace inside the payload (chunked encoders)', () => {
    const encoded = btoa('%PDF');
    const chunked = `${encoded.slice(0, 2)}\n${encoded.slice(2)}`;
    expect(String.fromCharCode(...pdfBytesFromBase64(chunked))).toBe('%PDF');
  });

  it('throws on malformed base64 (caller shows a failed compile)', () => {
    expect(() => pdfBytesFromBase64('not*base64!')).toThrow();
  });
});
