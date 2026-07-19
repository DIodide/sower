import { promises as fs } from 'node:fs';
import path from 'node:path';
import { exec } from './exec.js';

/**
 * LaTeX compilation via the tectonic CLI (installed into the container image
 * by Dockerfile.resume-editor; it must be on PATH). Tectonic downloads any
 * missing TeX bundle files on first use and caches them under
 * TECTONIC_CACHE_DIR (the image pre-warms /opt/tectonic-cache at build so a
 * fresh container's first compile skips the bundle download; locally the
 * default ~/.cache/Tectonic applies). The generous timeout covers the odd
 * package the warm-up did not bake in.
 */

export const TECTONIC_TIMEOUT_MS = 120_000;

/**
 * Basename suffix of the preprocessed temp copy actually handed to tectonic
 * (written NEXT TO the original so relative \input/graphics paths resolve
 * identically, removed again after the compile).
 */
export const BUILD_SUFFIX = '.sower-build';

/**
 * pdfTeX-only directives stripped from the temp copy before compiling.
 *
 * Jake's-template-style resumes carry `\input{glyphtounicode}` +
 * `\pdfgentounicode=1` so pdfTeX emits a unicode-mapped PDF (clean ATS
 * copy-paste). Both are pdfTeX PRIMITIVES: tectonic's XeTeX engine ships no
 * glyphtounicode.tex and has no \pdfgentounicode, so compiling the file
 * as-is halts with "glyphtounicode:…: Undefined control sequence". XeTeX
 * produces unicode-mapped PDFs natively, so dropping the directives loses
 * nothing. The patterns tolerate spacing/brace variants, and only the
 * directive itself is removed — the rest of each line (and every other
 * line) survives byte-for-byte, keeping error line numbers meaningful.
 */
const PDFTEX_ONLY_DIRECTIVES = [
  // \input{glyphtounicode} / \input { glyphtounicode.tex } / \input glyphtounicode
  /\\input\s*\{\s*glyphtounicode(?:\.tex)?\s*\}|\\input\s+glyphtounicode(?:\.tex)?\b/g,
  // \pdfgentounicode=1 (any spacing around the =)
  /\\pdfgentounicode\s*=\s*1/g,
];

/** Remove the pdfTeX-only directives above; everything else is untouched. */
export function stripPdfTexDirectives(source: string): string {
  let out = source;
  for (const directive of PDFTEX_ONLY_DIRECTIVES) {
    out = out.replace(directive, '');
  }
  return out;
}

/**
 * Compile `texFile` (a filename relative to `cwd`); the PDF lands in cwd
 * under the ORIGINAL name (`<name>.pdf`), exactly as callers expect.
 *
 * The repo file is never modified: tectonic runs against a preprocessed
 * temp copy (`<name>.sower-build.tex`, pdfTeX-only directives stripped) and
 * its output PDF is renamed to `<name>.pdf`. The temp copy and any leftover
 * temp PDF are removed afterwards, success or failure. If even the
 * preprocessed copy fails to compile, the thrown error names the original
 * file and carries tectonic's output via exec's (already redacted) detail.
 */
export async function compileTex(cwd: string, texFile: string): Promise<void> {
  const name = texFile.replace(/\.tex$/i, '');
  const buildTexFile = `${name}${BUILD_SUFFIX}.tex`;
  const buildTexPath = path.join(cwd, buildTexFile);
  const buildPdfPath = path.join(cwd, `${name}${BUILD_SUFFIX}.pdf`);
  const source = await fs.readFile(path.join(cwd, texFile), 'utf8');
  await fs.writeFile(buildTexPath, stripPdfTexDirectives(source), 'utf8');
  try {
    try {
      await exec('tectonic', [buildTexFile], {
        cwd,
        timeoutMs: TECTONIC_TIMEOUT_MS,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`compiling ${texFile} failed: ${detail}`);
    }
    // tectonic names the PDF after its input file — publish the original name.
    await fs.rename(buildPdfPath, path.join(cwd, `${name}.pdf`));
  } finally {
    await fs.rm(buildTexPath, { force: true });
    await fs.rm(buildPdfPath, { force: true });
  }
}
