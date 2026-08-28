import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { runCli } from './cli.js';
import { writeAuthConfig } from './config.js';

/**
 * Real-io entry point (bin/sower.js lands here via tsx). All logic lives
 * in cli.ts behind the injected io, so this file stays wiring-only: real
 * fs, real fetch, real process streams, and the process exit code.
 */

const code = await runCli(process.argv.slice(2), {
  env: process.env,
  fetch: (input, init) => fetch(input, init),
  // Undefined when stdout is a pipe — --pretty then falls back to $COLUMNS.
  columns: process.stdout.columns,
  stdout: (line) => {
    process.stdout.write(`${line}\n`);
  },
  stderr: (line) => {
    process.stderr.write(`${line}\n`);
  },
  readFile: (path) => readFileSync(path, 'utf8'),
  writeFile: (path, content) => {
    writeFileSync(path, content);
  },
  writeAuth: (update) => {
    writeAuthConfig(update, {
      // 0700 dir + 0600 file: the config holds the api token.
      mkdir: (path) => {
        mkdirSync(path, { recursive: true, mode: 0o700 });
      },
      readFile: (path) => readFileSync(path, 'utf8'),
      writeFile: (path, content) => {
        writeFileSync(path, content, { mode: 0o600 });
      },
      chmod: (path, mode) => {
        chmodSync(path, mode);
      },
    });
  },
});
// exitCode, not process.exit(): exit() tears the process down before large
// stdout finishes flushing through a pipe — outputs >64KB (tasks/export)
// were truncated mid-JSON for piped consumers (observed live, twice).
process.exitCode = code;
