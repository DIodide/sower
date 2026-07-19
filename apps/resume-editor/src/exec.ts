import { execFile } from 'node:child_process';
import { redactSecrets } from './redact.js';

/**
 * Subprocess runner for git/tectonic. Every failure path is scrubbed through
 * redactSecrets BEFORE the error is thrown, so the GitHub token (which lives
 * in the git insteadOf config and can echo back through git's own error
 * output) can never reach the resume_runs error column, the transcript, or
 * Cloud Run logs via an exec error.
 */

export interface ExecOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /** Secrets scrubbed from any thrown error (command line + output). */
  secrets?: readonly (string | undefined)[];
}

export interface ExecResult {
  stdout: string;
  stderr: string;
}

const DEFAULT_TIMEOUT_MS = 120_000;
/** Generous cap — a full-repo git clone progress dump stays well under it. */
const MAX_BUFFER_BYTES = 16 * 1024 * 1024;
/** Keep recorded errors readable; stderr tails can be enormous. */
const ERROR_DETAIL_CHARS = 4000;

export async function exec(
  cmd: string,
  args: string[],
  options: ExecOptions = {},
): Promise<ExecResult> {
  const secrets = options.secrets ?? [];
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      {
        cwd: options.cwd,
        env: options.env,
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxBuffer: MAX_BUFFER_BYTES,
        encoding: 'utf8',
      },
      (error, stdout, stderr) => {
        if (error) {
          // error.message embeds the full command line (which may carry the
          // token, e.g. the insteadOf config value) — redact everything.
          const rendered = redactSecrets(`${cmd} ${args.join(' ')}`, secrets);
          const detail = redactSecrets(
            [error.message, stderr]
              .filter((part) => part && part.length > 0)
              .join('\n')
              .slice(0, ERROR_DETAIL_CHARS),
            secrets,
          );
          reject(new Error(`\`${rendered}\` failed: ${detail}`));
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}
