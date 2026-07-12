import { createDb } from '@sower/db';
import { createQueue } from '@sower/queue';
import { loadConfig } from './config.js';
import { processTask } from './process.js';
import { buildServer } from './server.js';
import type { Deps, Queue } from './types.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const db = createDb(config.DATABASE_URL);

  // The inline queue handler closes over deps, which is assigned below before
  // the server starts accepting requests (so before any enqueue can happen).
  let deps: Deps;
  const queue: Queue = createQueue(config, async (taskId: string) => {
    await processTask(deps, taskId);
  });
  deps = { db, queue, config };

  const app = buildServer(deps);
  await app.listen({ port: config.PORT, host: '0.0.0.0' });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
