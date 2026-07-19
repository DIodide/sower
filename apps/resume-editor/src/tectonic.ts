import { exec } from './exec.js';

/**
 * LaTeX compilation via the tectonic CLI (installed into the container image
 * by Dockerfile.resume-editor; it must be on PATH). Tectonic downloads any
 * missing TeX bundle files on first use and caches them under
 * ~/.cache/Tectonic, so the first compile of a fresh container is the slow
 * one — hence the generous timeout.
 */

export const TECTONIC_TIMEOUT_MS = 120_000;

/** Compile `texFile` (a filename relative to `cwd`); the PDF lands in cwd. */
export async function compileTex(cwd: string, texFile: string): Promise<void> {
  await exec('tectonic', [texFile], {
    cwd,
    timeoutMs: TECTONIC_TIMEOUT_MS,
  });
}
