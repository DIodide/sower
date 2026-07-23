import {
  type ApprovalCard,
  type ApprovalMessagePayload,
  type ApprovalVerdict,
  applyVerdict,
  buildApprovalMessage,
  buildOtpRequestMessage,
  type DiscordActionRow,
  type DiscordEmbed,
  type OtpRequestCard,
} from './cards.js';
import {
  DISCORD_API_BASE,
  getDiscordBotToken,
  redactToken,
  resolveChannelId,
} from './config.js';

export interface ApprovalCardRef {
  channelId: string;
  messageId: string;
}

interface DiscordMessageResponse extends Partial<ApprovalMessagePayload> {
  id: string;
  channel_id?: string;
}

/**
 * Minimal Discord REST call. The bot token comes exclusively from the
 * DISCORD_BOT_TOKEN env var and is redacted from any thrown error.
 */
async function discordRequest(
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<unknown> {
  const token = getDiscordBotToken();
  if (!token) {
    throw new Error(
      'DISCORD_BOT_TOKEN is not set; Discord notifications are disabled',
    );
  }
  const response = await fetch(`${DISCORD_API_BASE}${path}`, {
    method,
    headers: {
      authorization: `Bot ${token}`,
      'content-type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(
      redactToken(
        `Discord API ${method} ${path} failed: ${response.status} ${text}`,
      ),
    );
  }
  // Some endpoints (e.g. adding a reaction) return 204 No Content.
  const text = await response.text();
  return text ? JSON.parse(text) : undefined;
}

function requireChannel(platform: string): string {
  const channelId = resolveChannelId(platform);
  if (!channelId) {
    throw new Error(
      `No Discord channel configured for platform "${platform}" and DISCORD_FALLBACK_CHANNEL is not set`,
    );
  }
  return channelId;
}

/**
 * Post an approval card (embed + Approve/Reject buttons) to the platform's
 * channel, falling back to DISCORD_FALLBACK_CHANNEL for unmapped platforms.
 * Returns the ids needed to edit the card later.
 */
export async function postApprovalCard(
  card: ApprovalCard,
): Promise<ApprovalCardRef> {
  const channelId = requireChannel(card.platform);
  const message = (await discordRequest(
    'POST',
    `/channels/${channelId}/messages`,
    buildApprovalMessage(card),
  )) as DiscordMessageResponse;
  return { channelId: message.channel_id ?? channelId, messageId: message.id };
}

/**
 * Post an OTP-request card ("Enter code" button) to the platform's channel.
 * Same channel routing and edit lifecycle as approval cards.
 */
export async function postOtpRequestCard(
  card: OtpRequestCard,
): Promise<ApprovalCardRef> {
  const channelId = requireChannel(card.platform);
  const message = (await discordRequest(
    'POST',
    `/channels/${channelId}/messages`,
    buildOtpRequestMessage(card),
  )) as DiscordMessageResponse;
  return { channelId: message.channel_id ?? channelId, messageId: message.id };
}

/**
 * Edit an existing approval card after a verdict: disable its buttons,
 * recolor the embed, and append a verdict line (plus optional detail).
 * Fetches the current message first so existing content is preserved.
 */
export async function updateApprovalCard(
  channelId: string,
  messageId: string,
  verdict: ApprovalVerdict,
  detail?: string,
): Promise<void> {
  let existing: Partial<ApprovalMessagePayload> = {};
  try {
    existing = (await discordRequest(
      'GET',
      `/channels/${channelId}/messages/${messageId}`,
    )) as DiscordMessageResponse;
  } catch {
    // Message fetch failed (deleted, permissions, ...): still patch a
    // minimal verdict embed so the card reflects the outcome.
  }
  await discordRequest(
    'PATCH',
    `/channels/${channelId}/messages/${messageId}`,
    applyVerdict(existing, verdict, detail),
  );
}

/** Post a plain text status message to the platform's channel. */
export async function notifyText(
  platform: string,
  text: string,
): Promise<void> {
  const channelId = requireChannel(platform);
  await discordRequest('POST', `/channels/${channelId}/messages`, {
    content: text,
  });
}

/** A channel message, trimmed to the fields the ingest poll consults. */
export interface DiscordChannelMessage {
  id: string;
  content: string;
  author?: { id: string; bot?: boolean };
  reactions?: { me: boolean; emoji: { name: string | null } }[];
  /** Uploaded files (screenshots etc.) as Discord returns them (CDN urls). */
  attachments?: {
    id: string;
    filename: string;
    content_type?: string;
    url: string;
    proxy_url?: string;
    size: number;
    width?: number;
    height?: number;
  }[];
}

/**
 * Fetch recent messages from a channel (Discord returns newest-first). Reading
 * message `content` for other users' messages requires the Message Content
 * privileged intent to be enabled for the bot.
 */
export async function fetchChannelMessages(
  channelId: string,
  opts: { limit?: number; after?: string } = {},
): Promise<DiscordChannelMessage[]> {
  const params = new URLSearchParams({ limit: String(opts.limit ?? 50) });
  if (opts.after) {
    params.set('after', opts.after);
  }
  const result = await discordRequest(
    'GET',
    `/channels/${channelId}/messages?${params.toString()}`,
  );
  return (result ?? []) as DiscordChannelMessage[];
}

/**
 * Add a unicode-emoji reaction to a message (the ingest poll's "processed"
 * marker + user-facing status). Returns 204, so no body is parsed.
 */
export async function addReaction(
  channelId: string,
  messageId: string,
  emoji: string,
): Promise<void> {
  await discordRequest(
    'PUT',
    `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`,
  );
}

/**
 * A message payload beyond plain text: embeds and button rows. Keys left
 * undefined are omitted from the request body, so a PATCH carrying only
 * `embeds` leaves the message's existing components untouched.
 */
export interface ChannelMessagePayload {
  content?: string;
  embeds?: DiscordEmbed[];
  components?: DiscordActionRow[];
}

/** A fetched message, trimmed to the payload keys an edit can round-trip. */
export interface ChannelMessageDetail extends ChannelMessagePayload {
  id: string;
}

/** Plain-string callers keep posting `{content}`; payloads pass through. */
function toMessageBody(
  message: string | ChannelMessagePayload,
): ChannelMessagePayload {
  return typeof message === 'string' ? { content: message } : message;
}

/**
 * Post a message to a specific channel id (not platform-keyed): a plain
 * string, or a `{content?, embeds?, components?}` payload. Returns the
 * created message's id so the caller can edit it later (the ingest poll
 * stores it on the tasks the message announced).
 */
export async function postChannelMessage(
  channelId: string,
  message: string | ChannelMessagePayload,
): Promise<{ id: string }> {
  const created = (await discordRequest(
    'POST',
    `/channels/${channelId}/messages`,
    toMessageBody(message),
  )) as DiscordMessageResponse;
  return { id: created.id };
}

/**
 * Edit a previously posted channel message (the #ingest reply refresh): a
 * plain string patches `{content}`, a payload patches exactly the keys it
 * carries (omitting `components` preserves the message's buttons). The
 * edited message keeps the bot as author, so the ingest poll's app-id
 * self-skip still ignores it — editing is loop-safe.
 */
export async function editChannelMessage(
  channelId: string,
  messageId: string,
  message: string | ChannelMessagePayload,
): Promise<void> {
  await discordRequest(
    'PATCH',
    `/channels/${channelId}/messages/${messageId}`,
    toMessageBody(message),
  );
}

/**
 * Fetch one message's editable payload (content/embeds/components) — the
 * #ingest refresh reads the current embed to preserve its quoted-message
 * field across re-renders.
 */
export async function getChannelMessage(
  channelId: string,
  messageId: string,
): Promise<ChannelMessageDetail> {
  return (await discordRequest(
    'GET',
    `/channels/${channelId}/messages/${messageId}`,
  )) as ChannelMessageDetail;
}

/**
 * Delete a channel message. Deleting a message the bot did not author needs
 * the Manage Messages permission — a missing grant surfaces as a thrown 403
 * the caller must treat as "leave the message". Returns 204, no body.
 */
export async function deleteChannelMessage(
  channelId: string,
  messageId: string,
): Promise<void> {
  await discordRequest(
    'DELETE',
    `/channels/${channelId}/messages/${messageId}`,
  );
}
