import { beforeEach, describe, expect, it, vi } from 'vitest';

const execState = vi.hoisted(() => ({
  calls: [] as { cmd: string; args: string[]; cwd?: string }[],
  /** Ran instead of the real tectonic; gets the resolved input file path. */
  onExec: (async (_inputPath: string) => {}) as (
    inputPath: string,
  ) => Promise<void>,
}));

vi.mock('./exec.js', () => ({
  exec: vi.fn(
    async (cmd: string, args: string[], options?: { cwd?: string }) => {
      execState.calls.push({ cmd, args, cwd: options?.cwd });
      await execState.onExec(
        path.join(options?.cwd ?? '', args[args.length - 1] ?? ''),
      );
      return { stdout: '', stderr: '' };
    },
  ),
}));

import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll } from 'vitest';
import {
  compileTex,
  describeBraceImbalance,
  stripPdfTexDirectives,
} from './tectonic.js';

const workdir = await mkdtemp(path.join(tmpdir(), 'sower-tectonic-test-'));
afterAll(async () => {
  await rm(workdir, { recursive: true, force: true });
});

/** The two pdfTeX-only lines exactly as Jake's resume template carries them. */
const JAKES_TEMPLATE = [
  '\\documentclass[letterpaper,11pt]{article}',
  '\\usepackage{latexsym}',
  '\\input{glyphtounicode}',
  '\\begin{document}',
  '\\pdfgentounicode=1',
  'Ibraheem Amin',
  '\\end{document}',
].join('\n');

beforeEach(() => {
  execState.calls = [];
  // Default tectonic stand-in: write the PDF next to the compiled input,
  // named after it — exactly what the real tectonic does.
  execState.onExec = async (inputPath) => {
    await writeFile(inputPath.replace(/\.tex$/, '.pdf'), 'pdf-bytes');
  };
});

describe('stripPdfTexDirectives', () => {
  it('removes both pdfTeX-only directives and touches nothing else', () => {
    const stripped = stripPdfTexDirectives(JAKES_TEMPLATE);
    expect(stripped).not.toContain('glyphtounicode');
    expect(stripped).not.toContain('pdfgentounicode');
    // Every other line survives byte-for-byte, line numbers preserved.
    expect(stripped.split('\n')).toEqual([
      '\\documentclass[letterpaper,11pt]{article}',
      '\\usepackage{latexsym}',
      '',
      '\\begin{document}',
      '',
      'Ibraheem Amin',
      '\\end{document}',
    ]);
  });

  it.each([
    ['\\input{glyphtounicode}'],
    ['\\input {glyphtounicode}'],
    ['\\input { glyphtounicode }'],
    ['\\input{glyphtounicode.tex}'],
    ['\\input glyphtounicode'],
    ['\\input glyphtounicode.tex'],
  ])('strips the glyphtounicode variant %j', (line) => {
    expect(stripPdfTexDirectives(line).trim()).toBe('');
  });

  it.each([
    ['\\pdfgentounicode=1'],
    ['\\pdfgentounicode = 1'],
    ['\\pdfgentounicode= 1'],
    ['\\pdfgentounicode =1'],
  ])('strips the pdfgentounicode variant %j', (line) => {
    expect(stripPdfTexDirectives(line).trim()).toBe('');
  });

  it('keeps the rest of a line the directive shares (only the match is cut)', () => {
    expect(
      stripPdfTexDirectives('\\pdfgentounicode=1 % ATS copy-paste quality'),
    ).toBe(' % ATS copy-paste quality');
  });

  it('leaves non-directive look-alikes alone', () => {
    const untouched = [
      '\\input{preamble}',
      '\\newcommand{\\glyphy}{x}',
      'text about glyphtounicode mapping',
    ].join('\n');
    expect(stripPdfTexDirectives(untouched)).toBe(untouched);
  });
});

describe('compileTex', () => {
  it('compiles a preprocessed temp copy, publishes the PDF under the original name, and cleans up', async () => {
    await writeFile(path.join(workdir, 'Resume.tex'), JAKES_TEMPLATE);

    let compiledSource = '';
    execState.onExec = async (inputPath) => {
      compiledSource = await readFile(inputPath, 'utf8');
      await writeFile(inputPath.replace(/\.tex$/, '.pdf'), 'pdf-bytes');
    };

    await compileTex(workdir, 'Resume.tex');

    // tectonic ran on the TEMP COPY (same dir, so relative includes resolve)…
    expect(execState.calls).toEqual([
      { cmd: 'tectonic', args: ['Resume.sower-build.tex'], cwd: workdir },
    ]);
    // …whose source had the pdfTeX-only directives stripped.
    expect(compiledSource).not.toContain('glyphtounicode');
    expect(compiledSource).not.toContain('pdfgentounicode');
    expect(compiledSource).toContain('Ibraheem Amin');
    // The published PDF carries the ORIGINAL name (what modes.ts reads/uploads).
    expect(await readFile(path.join(workdir, 'Resume.pdf'), 'utf8')).toBe(
      'pdf-bytes',
    );
    // The repo .tex is untouched; no temp artifacts remain.
    expect(await readFile(path.join(workdir, 'Resume.tex'), 'utf8')).toBe(
      JAKES_TEMPLATE,
    );
    const leftovers = (await readdir(workdir)).filter((f) =>
      f.includes('.sower-build'),
    );
    expect(leftovers).toEqual([]);
  });

  it('surfaces a compile failure under the original name and still cleans up the temp copy', async () => {
    await writeFile(path.join(workdir, 'Broken.tex'), JAKES_TEMPLATE);
    execState.onExec = async () => {
      // exec's real error shape: command line + redacted stderr detail.
      throw new Error(
        '`tectonic Broken.sower-build.tex` failed: error: halted on Broken.sower-build.tex',
      );
    };

    await expect(compileTex(workdir, 'Broken.tex')).rejects.toThrow(
      /compiling Broken\.tex failed: .*halted/,
    );

    const leftovers = (await readdir(workdir)).filter((f) =>
      f.includes('Broken.sower-build'),
    );
    expect(leftovers).toEqual([]);
    // No PDF was published for the failed compile.
    await expect(
      readFile(path.join(workdir, 'Broken.pdf'), 'utf8'),
    ).rejects.toThrow();
  });
});

describe('describeBraceImbalance', () => {
  it('returns null for balanced source, including escaped braces', () => {
    expect(describeBraceImbalance('\\textbf{ok} \\small{x}')).toBeNull();
    // \{ and \} are literal characters, not grouping.
    expect(describeBraceImbalance('a \\{ b \\} c')).toBeNull();
    expect(describeBraceImbalance('')).toBeNull();
  });

  it('ignores braces inside comments but not an escaped percent', () => {
    expect(describeBraceImbalance('% a stray { in prose')).toBeNull();
    expect(describeBraceImbalance('\\textbf{100\\% done}')).toBeNull();
  });

  it('names the line where the surviving brace opened', () => {
    const source = ['\\begin{center}', '\\small{\\item{', 'body', '}'].join(
      '\n',
    );
    expect(describeBraceImbalance(source)).toMatch(
      /1 unclosed '\{' — the last one opens at line 2/,
    );
  });

  it('points into the awards block for the real dropped-brace regression', () => {
    // The exact shape that broke a live compile: the \textbf{Awards}{: …}
    // group lost its closing brace, and tectonic blamed \end{itemize} two
    // lines below.
    const source = [
      '\\begin{itemize}[leftmargin=0.15in, label={}]',
      '   \\small{\\item{',
      '    \\textbf{Awards}{: Qualcomm Honorable Mention, COSCON Honor',
      '   }}',
      '\\end{itemize}',
    ].join('\n');
    const hint = describeBraceImbalance(source);
    expect(hint).toContain('1 unclosed');
    expect(hint).toContain('line 2');
  });

  it('truncates a long culprit line in the hint', () => {
    const hint = describeBraceImbalance(`\\item{${'x'.repeat(200)}`);
    expect(hint).toContain('…');
    expect((hint ?? '').length).toBeLessThan(160);
  });
});
