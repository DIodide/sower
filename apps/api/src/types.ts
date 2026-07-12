import type { createDb } from '@sower/db';
import type { Config } from './config.js';

export type Db = ReturnType<typeof createDb>;

export interface Queue {
  enqueueProcess(taskId: string): Promise<void>;
}

export interface Deps {
  db: Db;
  queue: Queue;
  config: Config;
  /** Set to false in tests to silence the pino logger. Defaults to true. */
  logger?: boolean;
}
