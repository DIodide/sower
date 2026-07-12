import type { AnswerBank } from '@sower/answers';
import type { createDb } from '@sower/db';
import type {
  ApprovalCard,
  ApprovalCardRef,
  ApprovalMessagePayload,
  ApprovalVerdict,
} from '@sower/notify';
import type { Config } from './config.js';

export type Db = ReturnType<typeof createDb>;

export interface Queue {
  enqueueProcess(taskId: string): Promise<void>;
}

/**
 * Discord notification surface, structurally matching @sower/notify. Wired to
 * the real module in src/index.ts and injected as a fake in tests. Absent (or
 * config.DISCORD_ENABLED false), all Discord features are skipped silently.
 *
 * SAFETY: nothing here talks to an ATS/apply endpoint — postApprovalCard and
 * updateApprovalCard call the Discord API only, verifyInteraction and
 * applyVerdict are pure. The bot token stays inside @sower/notify (env only).
 */
export interface Notifier {
  postApprovalCard(card: ApprovalCard): Promise<ApprovalCardRef>;
  updateApprovalCard(
    channelId: string,
    messageId: string,
    verdict: ApprovalVerdict,
    detail?: string,
  ): Promise<void>;
  verifyInteraction(
    publicKey: string,
    signature: string,
    timestamp: string,
    rawBody: string | Buffer | Uint8Array,
  ): boolean;
  applyVerdict(
    existing: Partial<ApprovalMessagePayload>,
    verdict: ApprovalVerdict,
    detail?: string,
  ): ApprovalMessagePayload;
}

export interface Deps {
  db: Db;
  queue: Queue;
  config: Config;
  /** Discord notifier; omit to disable all Discord features. */
  notify?: Notifier;
  /**
   * Curated answer bank, loaded once at startup from
   * config.ANSWER_BANK_PATH. Omit (bank file missing/invalid) to resolve
   * answers without it — existing behavior is preserved.
   */
  answerBank?: AnswerBank;
  /** Set to false in tests to silence the pino logger. Defaults to true. */
  logger?: boolean;
}
