import { readFileSync } from 'node:fs';
import { fillSessionOverCdp } from './browser.js';
import { resolveOpenTabConfig, resolveSowerConfig } from './config.js';
import { runTick } from './loop.js';
import type { OpenTabSession } from './opentab-client.js';
import { makeOpenTabClient } from './opentab-client.js';
import type { FillPayload } from './sower-client.js';
import { makeSowerClient } from './sower-client.js';

/**
 * Runner daemon entry (`pnpm --filter @sower/runner start`, launchd in
 * production — see README.md). Polls the sower api for fill jobs, opens a
 * greenhouse tab via OpenTab, fills it over CDP, and reports back. Exits
 * cleanly on SIGTERM/SIGINT after finishing the job in flight.
 */

const DEFAULT_POLL_SECONDS = 15;

function log(line: string): void {
  console.log(`[${new Date().toISOString()}] ${line}`);
}

function readTextFile(path: string): string {
  return readFileSync(path, 'utf8');
}

async function main(): Promise<void> {
  const sowerConfig = resolveSowerConfig(process.env, readTextFile);
  if (sowerConfig.token === null) {
    console.error(
      'no sower api token: set SOWER_API_KEY or run `sower auth set`',
    );
    process.exit(3);
  }
  const opentabConfig = resolveOpenTabConfig(process.env, readTextFile);
  if (opentabConfig.token === null) {
    console.error(
      'no opentab token: set OPENTAB_TOKEN or run `opentab serve` once to create ~/.opentab/token',
    );
    process.exit(3);
  }
  const pollSeconds =
    Number(process.env.POLL_SECONDS ?? '') || DEFAULT_POLL_SECONDS;
  const sower = makeSowerClient({
    base: sowerConfig.base,
    token: sowerConfig.token,
    fetch,
  });
  const deps = {
    sower,
    opentab: makeOpenTabClient({
      base: opentabConfig.base,
      token: opentabConfig.token,
      fetch,
    }),
    // File questions upload the stored document; its bytes come from the api.
    fill: (session: OpenTabSession, payload: FillPayload) =>
      fillSessionOverCdp(session, payload, sower),
    log,
    // Scrubbed from every outbound string (fail errors, report details, logs).
    secrets: [opentabConfig.token, sowerConfig.token],
  };

  let running = true;
  let wake: (() => void) | null = null;
  const stop = (signal: string): void => {
    log(`${signal}: finishing the current job, then exiting`);
    running = false;
    wake?.();
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));

  log(
    `polling ${sowerConfig.base} every ${pollSeconds}s (opentab at ${opentabConfig.base})`,
  );
  while (running) {
    try {
      // Drain the queue before sleeping so back-to-back jobs start promptly.
      while (running && (await runTick(deps))) {
        // A job was processed; claim again immediately.
      }
    } catch (error) {
      log(
        `tick failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!running) {
      break;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, pollSeconds * 1000);
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    wake = null;
  }
}

main().catch((error) => {
  console.error(
    error instanceof Error ? (error.stack ?? error.message) : String(error),
  );
  process.exit(1);
});
