import type { AnswerBank } from '@sower/answers';
import type { createDb } from '@sower/db';
import type {
  ApprovalCard,
  ApprovalCardRef,
  ApprovalMessagePayload,
  ApprovalVerdict,
  DiscordChannelMessage,
  OtpRequestCard,
} from '@sower/notify';
import type { Storage } from '@sower/storage';
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
  postOtpRequestCard(card: OtpRequestCard): Promise<ApprovalCardRef>;
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
  /** Read recent channel messages (Discord ingest poll). */
  fetchChannelMessages(
    channelId: string,
    opts?: { limit?: number; after?: string },
  ): Promise<DiscordChannelMessage[]>;
  /** React to a message — the ingest poll's processed marker + status. */
  addReaction(
    channelId: string,
    messageId: string,
    emoji: string,
  ): Promise<void>;
  /** Post a plain-text message to a specific channel id (returns its id). */
  postChannelMessage(channelId: string, text: string): Promise<{ id: string }>;
  /** Edit a previously posted channel message (the #ingest reply refresh). */
  editChannelMessage(
    channelId: string,
    messageId: string,
    content: string,
  ): Promise<void>;
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
  /**
   * Vault storage. Used to load a captured Workday session (per tenant) so the
   * pipeline can read that job's questionnaire into jobSpec.questions. Omit to
   * disable Workday questionnaire reading (tasks park account-required).
   */
  storage?: Storage;
  /** Set to false in tests to silence the pino logger. Defaults to true. */
  logger?: boolean;
}
