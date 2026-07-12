import { type AnswerBank, loadAnswerBank } from '@sower/answers';
import { createDb } from '@sower/db';
import {
  applyVerdict,
  postApprovalCard,
  updateApprovalCard,
  verifyInteraction,
} from '@sower/notify';
import { createQueue } from '@sower/queue';
import { loadConfig } from './config.js';
import { processTask } from './process.js';
import { buildServer } from './server.js';
import type { Deps, Notifier, Queue } from './types.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const db = createDb(config.DATABASE_URL);

  // Discord surface (@sower/notify). Always wired: verifyInteraction needs
  // only the public key; outbound calls are gated on DISCORD_ENABLED (bot
  // token present) and the token itself never leaves @sower/notify.
  const notify: Notifier = {
    postApprovalCard,
    updateApprovalCard,
    verifyInteraction,
    applyVerdict,
  };

  // Curated answer bank, loaded ONCE at startup and reused per request. A
  // missing or invalid bank file only logs a warning: resolution then runs
  // without the bank stage, exactly as before the bank existed.
  let answerBank: AnswerBank | undefined;
  try {
    answerBank = loadAnswerBank(config.ANSWER_BANK_PATH);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[sower] answer bank disabled: ${message}`);
  }

  // The inline queue handler closes over deps, which is assigned below before
  // the server starts accepting requests (so before any enqueue can happen).
  let deps: Deps;
  const queue: Queue = createQueue(config, async (taskId: string) => {
    await processTask(deps, taskId);
  });
  deps = { db, queue, config, notify, answerBank };

  const app = buildServer(deps);
  await app.listen({ port: config.PORT, host: '0.0.0.0' });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
