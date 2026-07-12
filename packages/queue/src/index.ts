import { CloudTasksClient } from '@google-cloud/tasks';

/** A queue that schedules processing of an application task by id. */
export interface TaskQueue {
  enqueueProcess(taskId: string): Promise<void>;
}

/** Handler invoked by the inline driver to process a task. */
export type ProcessHandler = (taskId: string) => Promise<void>;

/**
 * In-process queue driver: fires the handler on the next macrotask via
 * setImmediate. Handler failures (sync throws or rejections) are swallowed
 * and logged — they never crash or reject for the caller.
 */
export function createInlineQueue(handler: ProcessHandler): TaskQueue {
  return {
    async enqueueProcess(taskId: string): Promise<void> {
      setImmediate(() => {
        void Promise.resolve()
          .then(() => handler(taskId))
          .catch((err) => {
            console.error(
              `[queue:inline] handler failed for task ${taskId}:`,
              err,
            );
          });
      });
    },
  };
}

export interface CloudTasksQueueOptions {
  projectId: string;
  region: string;
  queue: string;
  targetBaseUrl: string;
  apiKey: string;
}

/**
 * Google Cloud Tasks driver: each enqueue creates a Cloud Task that POSTs
 * `{ taskId }` as JSON to `${targetBaseUrl}/tasks/process` with the
 * x-api-key header set.
 */
export function createCloudTasksQueue(opts: CloudTasksQueueOptions): TaskQueue {
  const client = new CloudTasksClient();
  const parent = client.queuePath(opts.projectId, opts.region, opts.queue);
  const url = `${opts.targetBaseUrl.replace(/\/+$/, '')}/tasks/process`;

  return {
    async enqueueProcess(taskId: string): Promise<void> {
      await client.createTask({
        parent,
        task: {
          httpRequest: {
            httpMethod: 'POST',
            url,
            headers: {
              'content-type': 'application/json',
              'x-api-key': opts.apiKey,
            },
            body: Buffer.from(JSON.stringify({ taskId })),
          },
        },
      });
    },
  };
}

export type QueueDriver = 'inline' | 'cloud-tasks';

/**
 * Env-like config consumed by createQueue. Field names mirror the API's
 * environment variables so a validated config object can be passed through.
 */
export interface QueueConfig {
  QUEUE_DRIVER: QueueDriver;
  GCP_PROJECT_ID?: string | undefined;
  GCP_REGION?: string | undefined;
  TASKS_QUEUE?: string | undefined;
  TASKS_TARGET_BASE_URL?: string | undefined;
  INGEST_API_KEY?: string | undefined;
}

/**
 * Factory that picks the queue driver from config.
 *
 * - QUEUE_DRIVER 'inline' requires the `handler` argument.
 * - QUEUE_DRIVER 'cloud-tasks' requires GCP_PROJECT_ID, GCP_REGION,
 *   TASKS_TARGET_BASE_URL and INGEST_API_KEY (TASKS_QUEUE defaults to
 *   'apply-queue').
 */
export function createQueue(
  config: QueueConfig,
  handler?: ProcessHandler,
): TaskQueue {
  switch (config.QUEUE_DRIVER) {
    case 'inline': {
      if (!handler) {
        throw new Error(
          "createQueue: QUEUE_DRIVER 'inline' requires a process handler",
        );
      }
      return createInlineQueue(handler);
    }
    case 'cloud-tasks': {
      const required = {
        GCP_PROJECT_ID: config.GCP_PROJECT_ID,
        GCP_REGION: config.GCP_REGION,
        TASKS_TARGET_BASE_URL: config.TASKS_TARGET_BASE_URL,
        INGEST_API_KEY: config.INGEST_API_KEY,
      };
      const missing = Object.entries(required)
        .filter(([, value]) => !value)
        .map(([key]) => key);
      if (missing.length > 0) {
        throw new Error(
          `createQueue: QUEUE_DRIVER 'cloud-tasks' requires ${missing.join(', ')}`,
        );
      }
      return createCloudTasksQueue({
        projectId: config.GCP_PROJECT_ID as string,
        region: config.GCP_REGION as string,
        queue: config.TASKS_QUEUE ?? 'apply-queue',
        targetBaseUrl: config.TASKS_TARGET_BASE_URL as string,
        apiKey: config.INGEST_API_KEY as string,
      });
    }
    default: {
      throw new Error(
        `createQueue: unknown QUEUE_DRIVER '${config.QUEUE_DRIVER as string}'`,
      );
    }
  }
}
