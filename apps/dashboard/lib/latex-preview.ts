// Pure helpers for the Edit tab's compile preview. They live in lib/ (not
// app/answers/resumes/) because dashboard unit tests are only collected from
// lib/ — see vitest.config.ts at the repo root.

/**
 * Headline error of a TeX/tectonic log. Tectonic reports as
 * `error: <file>:<line>: <message>` (TeX's own `!` lines only appear in
 * engine passthrough); prefer a `!` line, then the first file:line
 * diagnostic, then any `error:` line — the "halted on …" wrap-up is a last
 * resort.
 */
export function firstLatexError(log: string): string | null {
  let firstError: string | null = null;
  for (const line of log.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith('!')) return trimmed;
    if (trimmed.startsWith('error:')) {
      if (/\.tex:\d+/.test(trimmed)) return trimmed;
      firstError ??= trimmed;
    }
  }
  return firstError;
}

/**
 * base64 → bytes for the preview Blob. Browser atob, never Node Buffer —
 * this runs in the client component. Throws on malformed input; the caller
 * treats that as a failed compile. Typed Uint8Array<ArrayBuffer> (which the
 * plain constructor guarantees) so the result satisfies BlobPart under TS's
 * SharedArrayBuffer-aware DOM types.
 */
export function pdfBytesFromBase64(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64.replace(/\s+/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
