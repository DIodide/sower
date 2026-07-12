import type { ResolutionResult, TaskState } from '@sower/core';
import { applicationTasks, events } from '@sower/db';
import type { ApprovalCard, ApprovalMessagePayload } from '@sower/notify';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { approveTask } from './task-actions.js';
import type { Db, Deps } from './types.js';

/**
 * Discord wiring for apps/api.
 *
 * AUTH MODEL: POST /discord/interactions is deliberately NOT behind the
 * x-api-key preHandler. It is authenticated by Ed25519 signature verification
 * (X-Signature-Ed25519 / X-Signature-Timestamp over the RAW request body)
 * against DISCORD_PUBLIC_KEY; an invalid signature is rejected with 401.
 *
 * SAFETY: the approve button reuses approveTask, which performs a DRY-RUN
 * submit only — the payload is constructed and recorded, never sent to any
 * apply/submit endpoint. Interaction responses (type 7) edit the card without
 * any outbound Discord call, so the whole handler stays inside Discord's 3s
 * response window. The bot token is never read or logged here.
 */

/** Discord interaction request types (subset handled here). */
const INTERACTION_PING = 1;
const INTERACTION_MESSAGE_COMPONENT = 3;

/** Discord interaction response types. */
const RESPONSE_PONG = 1;
const RESPONSE_CHANNEL_MESSAGE = 4;
const RESPONSE_UPDATE_MESSAGE = 7;

/** Message flag: response is visible only to the user who clicked. */
const FLAG_EPHEMERAL = 64;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The subset of a Discord interaction payload this handler reads. */
interface DiscordInteraction {
  type: number;
  data?: { custom_id?: string };
  /** The message the clicked component is attached to (the approval card). */
  message?: Partial<ApprovalMessagePayload>;
}

export interface InteractionReply {
  status: number;
  body: unknown;
}

export interface InteractionInput {
  /** The RAW request body, exactly as received (signature covers these bytes). */
  rawBody: Buffer | string;
  signature: string | undefined;
  timestamp: string | undefined;
}

/**
 * Build the POST /discord/interactions handler: verify the Ed25519 signature
 * (401 on failure), answer PING with PONG, and dispatch approve/reject
 * button clicks. Approve reuses the /tasks/:id/approve service fn (dry-run
 * submit only); reject records a 'REJECTED' event without changing state.
 */
export function buildInteractionsHandler(
  deps: Deps,
): (input: InteractionInput) => Promise<InteractionReply> {
  return async function handleInteraction(input) {
    const { notify, config } = deps;
    if (!notify) {
      // No notifier wired at boot: the endpoint exists but cannot verify.
      return {
        status: 503,
        body: { error: 'discord interactions not configured' },
      };
    }

    const { rawBody, signature, timestamp } = input;
    if (
      signature === undefined ||
      timestamp === undefined ||
      !notify.verifyInteraction(
        config.DISCORD_PUBLIC_KEY,
        signature,
        timestamp,
        rawBody,
      )
    ) {
      return { status: 401, body: { error: 'invalid request signature' } };
    }

    let interaction: DiscordInteraction;
    try {
      interaction = JSON.parse(
        typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8'),
      ) as DiscordInteraction;
    } catch {
      return { status: 400, body: { error: 'malformed interaction body' } };
    }

    if (interaction.type === INTERACTION_PING) {
      return { status: 200, body: { type: RESPONSE_PONG } };
    }
    if (interaction.type === INTERACTION_MESSAGE_COMPONENT) {
      return handleComponent(deps, interaction);
    }
    return {
      status: 400,
      body: { error: `unsupported interaction type ${interaction.type}` },
    };
  };
}

/** Dispatch an approve:/reject: button click. */
async function handleComponent(
  deps: Deps,
  interaction: DiscordInteraction,
): Promise<InteractionReply> {
  const customId = interaction.data?.custom_id ?? '';
  const separator = customId.indexOf(':');
  const action = separator === -1 ? customId : customId.slice(0, separator);
  const taskId = separator === -1 ? '' : customId.slice(separator + 1);
  if ((action !== 'approve' && action !== 'reject') || !UUID_RE.test(taskId)) {
    return {
      status: 400,
      body: { error: `unsupported component custom_id '${customId}'` },
    };
  }
  if (action === 'approve') {
    return approveInteraction(deps, taskId, interaction);
  }
  return rejectInteraction(deps, taskId, interaction);
}

/**
 * Approve button: run the exact same service fn as POST /tasks/:id/approve.
 * SAFETY: approveTask performs a DRY-RUN submit only (zero network I/O); the
 * type-7 response edits the card in place, so no bot-token call is needed.
 */
async function approveInteraction(
  deps: Deps,
  taskId: string,
  interaction: DiscordInteraction,
): Promise<InteractionReply> {
  const notify = requireNotify(deps);
  const outcome = await approveTask(deps, taskId);
  if (outcome.kind === 'not_found') {
    return ephemeral(`Task ${taskId} was not found.`);
  }
  if (outcome.kind === 'skipped') {
    return ephemeral(
      `Task is in state ${outcome.state}; only a REVIEW task can be approved.`,
    );
  }
  if (outcome.kind === 'failed') {
    return ephemeral(`Approve failed: ${outcome.error}`);
  }
  const { fieldCount, fileCount } = outcome.payloadSummary;
  return updateMessage(
    notify.applyVerdict(
      existingMessage(interaction),
      'approved',
      `dry-run submit recorded (${fieldCount} field(s), ${fileCount} file(s)); no real application was sent`,
    ),
  );
}

/**
 * Reject button: record a 'REJECTED' event on the task WITHOUT a state
 * change (fromState === toState). This is a review verdict, not a
 * state-machine transition — the task can still be requeued later.
 */
async function rejectInteraction(
  deps: Deps,
  taskId: string,
  interaction: DiscordInteraction,
): Promise<InteractionReply> {
  const notify = requireNotify(deps);
  const state = await currentTaskState(deps.db, taskId);
  if (state === null) {
    return ephemeral(`Task ${taskId} was not found.`);
  }
  await deps.db.insert(events).values({
    taskId,
    type: 'REJECTED',
    fromState: state,
    toState: state,
    data: { via: 'discord' },
  });
  return updateMessage(
    notify.applyVerdict(
      existingMessage(interaction),
      'rejected',
      `task left in ${state}`,
    ),
  );
}

/**
 * Register POST /discord/interactions inside an encapsulated plugin scope so
 * its 'application/json' content-type parser (parseAs: 'buffer') applies to
 * this route only: signature verification must see the exact raw bytes
 * Discord signed — the default JSON parser would destroy them.
 */
export function registerDiscordRoutes(app: FastifyInstance, deps: Deps): void {
  const handleInteraction = buildInteractionsHandler(deps);
  app.register(async (scope) => {
    scope.addContentTypeParser(
      'application/json',
      { parseAs: 'buffer' },
      (_request, payload, done) => {
        done(null, payload);
      },
    );
    scope.post('/discord/interactions', async (request, reply) => {
      const result = await handleInteraction({
        rawBody: request.body as Buffer,
        signature: headerValue(request.headers['x-signature-ed25519']),
        timestamp: headerValue(request.headers['x-signature-timestamp']),
      });
      return reply.code(result.status).send(result.body);
    });
  });
}

/** Input for the REVIEW-entry approval card. */
export interface ReviewCardInput {
  taskId: string;
  platform: string;
  company: string | null;
  title: string;
  applyUrl: string;
  resolution: ResolutionResult;
}

/**
 * Post the Discord approval card when a task enters REVIEW and persist the
 * returned {channelId, messageId} on the task (approval_channel_id /
 * approval_message_id, added in the dedupe/approval db migration).
 *
 * Best-effort by design: when Discord is disabled (no DISCORD_BOT_TOKEN) the
 * card is skipped silently (logged), and a Discord outage never fails task
 * processing.
 */
export async function postReviewApprovalCard(
  deps: Deps,
  input: ReviewCardInput,
): Promise<void> {
  const { config, notify, db } = deps;
  if (!config.DISCORD_ENABLED || !notify) {
    console.info(
      `[sower] discord disabled (no bot token); skipping approval card for task ${input.taskId}`,
    );
    return;
  }
  try {
    const { resolution } = input;
    const card: ApprovalCard = {
      taskId: input.taskId,
      platform: input.platform,
      company: input.company ?? '(unknown company)',
      title: input.title,
      applyUrl: input.applyUrl,
      fieldCount: resolution.resolved.length,
      fileCount: resolution.resolved.filter(
        (answer) => answer.source === 'document',
      ).length,
      missingRequired:
        resolution.requiredMissingCount ??
        resolution.missing.filter((question) => question.required).length,
    };
    const { channelId, messageId } = await notify.postApprovalCard(card);
    await db
      .update(applicationTasks)
      .set({
        approvalChannelId: channelId,
        approvalMessageId: messageId,
        updatedAt: new Date(),
      })
      .where(eq(applicationTasks.id, input.taskId));
  } catch (error) {
    // Tokens never appear in these errors (@sower/notify redacts them).
    console.warn(
      `[sower] failed to post Discord approval card for task ${input.taskId}:`,
      error,
    );
  }
}

/**
 * After a dashboard/API approve (dry-run), edit the stored approval card to
 * 'submitted-dryrun'. Best-effort; skipped when Discord is disabled or the
 * task has no stored card. The Discord-button approve path does NOT use this
 * (its type-7 interaction response already edits the card).
 */
export async function markApprovalCardSubmitted(
  deps: Deps,
  approval: { channelId: string; messageId: string } | null,
  summary: { fieldCount: number; fileCount: number },
): Promise<void> {
  const { config, notify } = deps;
  if (!config.DISCORD_ENABLED || !notify || !approval) {
    return;
  }
  try {
    await notify.updateApprovalCard(
      approval.channelId,
      approval.messageId,
      'submitted-dryrun',
      `dry-run submit recorded (${summary.fieldCount} field(s), ${summary.fileCount} file(s))`,
    );
  } catch (error) {
    console.warn('[sower] failed to update Discord approval card:', error);
  }
}

function requireNotify(deps: Deps): NonNullable<Deps['notify']> {
  const { notify } = deps;
  if (!notify) {
    // Unreachable via buildInteractionsHandler (it 503s first); guards
    // against direct calls.
    throw new Error('discord notifier not configured');
  }
  return notify;
}

async function currentTaskState(
  db: Db,
  taskId: string,
): Promise<TaskState | null> {
  const rows = await db
    .select({ state: applicationTasks.state })
    .from(applicationTasks)
    .where(eq(applicationTasks.id, taskId))
    .limit(1);
  const row = rows[0];
  return row ? (row.state as TaskState) : null;
}

function existingMessage(
  interaction: DiscordInteraction,
): Partial<ApprovalMessagePayload> {
  return {
    embeds: interaction.message?.embeds ?? [],
    components: interaction.message?.components ?? [],
  };
}

function updateMessage(data: ApprovalMessagePayload): InteractionReply {
  return {
    status: 200,
    body: { type: RESPONSE_UPDATE_MESSAGE, data },
  };
}

function ephemeral(content: string): InteractionReply {
  return {
    status: 200,
    body: {
      type: RESPONSE_CHANNEL_MESSAGE,
      data: { content, flags: FLAG_EPHEMERAL },
    },
  };
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
