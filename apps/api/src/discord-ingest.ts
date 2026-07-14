import { canonicalizeUrl } from '@sower/core';
import type { DiscordChannelMessage } from '@sower/notify';
import { detectPlatform, getAdapter, resolveUrl } from '@sower/platforms';
import {
  imageAttachments,
  ingestMessageAttachments,
} from './attachment-ingest.js';
import { ingestJob } from './ingest.js';
import {
  extractUrlsFromText,
  fetchJobLinks,
  unwrapRedirectShim,
} from './link-extract.js';
import type { Deps } from './types.js';

/**
 * Ingest job links + screenshots that arrive via Discord. The classifier is
 * ingress-agnostic; `runDiscordIngestPoll` is the channel adapter over it.
 *
 * The one invariant: NOTHING is silently dropped. Every URL you send resolves
 * to exactly one outcome — ingested (supported), recorded-and-parked
 * (unsupported, via ingestJob's unknown-platform path), expanded into child
 * links (a directory), or reported as an error — and the reply itemizes it.
 * Image attachments (screenshots) are stored + parked for dashboard triage
 * (see attachment-ingest.ts), so an image-only message is handled too.
 */

const MAX_URLS_PER_MESSAGE = 25;
const MAX_DIRECTORY_LINKS = 50;
const SOURCE = 'discord';

export type UrlOutcome =
  | { url: string; kind: 'ingested'; platform: string; jobId: string }
  | { url: string; kind: 'duplicate'; jobId: string }
  | { url: string; kind: 'unsupported'; jobId: string }
  | { url: string; kind: 'directory'; children: UrlOutcome[] }
  | { url: string; kind: 'error'; error: string };

export interface MessageIngestSummary {
  urls: number;
  ingested: number;
  duplicates: number;
  unsupported: number;
  directories: number;
  errors: number;
  /** Image attachments stored + parked for dashboard triage. */
  screenshots: number;
  outcomes: UrlOutcome[];
}

/** Workday returns platform:'workday' for ANY tenant host; only a /job/ or
 *  /details/ path is an actual posting we can discover. Everything else
 *  (login/careers landing) falls through to directory-expand-or-record. */
function isIngestableJobUrl(platform: string, url: string): boolean {
  if (platform !== 'workday') return true;
  try {
    return /\/(job|details)\//i.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

/** Classify one URL and route it: supported→ingest, unknown→expand-or-record. */
async function classifyAndIngest(
  deps: Deps,
  url: string,
  depth: number,
): Promise<UrlOutcome> {
  try {
    const resolved = await resolveUrl(unwrapRedirectShim(url));
    const ref = detectPlatform(canonicalizeUrl(resolved));

    // Supported platform with a resolvable tenant → normal ingest (enqueues).
    if (
      getAdapter(ref.platform) &&
      ref.tenant !== null &&
      isIngestableJobUrl(ref.platform, resolved)
    ) {
      const result = await ingestJob(deps, { url: resolved, source: SOURCE });
      return result.duplicate
        ? { url: resolved, kind: 'duplicate', jobId: result.jobId }
        : {
            url: resolved,
            kind: 'ingested',
            platform: ref.platform,
            jobId: result.jobId,
          };
    }

    // Unknown/unsupported at the top level → maybe it's a directory page.
    if (depth === 0) {
      const links = await fetchJobLinks(resolved);
      if (links.length > 0) {
        const children: UrlOutcome[] = [];
        for (const link of links.slice(0, MAX_DIRECTORY_LINKS)) {
          children.push(await classifyAndIngest(deps, link, depth + 1));
        }
        return { url: resolved, kind: 'directory', children };
      }
    }

    // A single unsupported job (or an unparseable page): record + park it so
    // it's captured and visible, never lost. ingestJob parks unknown platforms.
    const result = await ingestJob(deps, { url: resolved, source: SOURCE });
    return result.duplicate
      ? { url: resolved, kind: 'duplicate', jobId: result.jobId }
      : { url: resolved, kind: 'unsupported', jobId: result.jobId };
  } catch (error) {
    return {
      url,
      kind: 'error',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function summarize(
  urlCount: number,
  outcomes: UrlOutcome[],
): MessageIngestSummary {
  const summary: MessageIngestSummary = {
    urls: urlCount,
    ingested: 0,
    duplicates: 0,
    unsupported: 0,
    directories: 0,
    errors: 0,
    screenshots: 0,
    outcomes,
  };
  const tally = (outcome: UrlOutcome): void => {
    switch (outcome.kind) {
      case 'ingested':
        summary.ingested += 1;
        break;
      case 'duplicate':
        summary.duplicates += 1;
        break;
      case 'unsupported':
        summary.unsupported += 1;
        break;
      case 'error':
        summary.errors += 1;
        break;
      case 'directory':
        summary.directories += 1;
        for (const child of outcome.children) {
          tally(child);
        }
        break;
    }
  };
  for (const outcome of outcomes) {
    tally(outcome);
  }
  return summary;
}

/** Extract every URL from a message and classify+ingest each. */
export async function ingestMessageLinks(
  deps: Deps,
  text: string,
): Promise<MessageIngestSummary> {
  const urls = extractUrlsFromText(text).slice(0, MAX_URLS_PER_MESSAGE);
  const outcomes: UrlOutcome[] = [];
  for (const url of urls) {
    outcomes.push(await classifyAndIngest(deps, url, 0));
  }
  return summarize(urls.length, outcomes);
}

/**
 * Ingest everything a message carries: text links AND image attachments
 * (screenshots), merged into one summary for the reaction + reply.
 */
export async function ingestMessage(
  deps: Deps,
  message: DiscordChannelMessage,
): Promise<MessageIngestSummary> {
  const summary = await ingestMessageLinks(deps, message.content ?? '');
  const screenshots = await ingestMessageAttachments(deps, message);
  return { ...summary, screenshots: screenshots.length };
}

/** Emoji that best captures a message's result (the "processed" marker too). */
export function reactionFor(summary: MessageIngestSummary): string {
  if (summary.ingested > 0) return '✅';
  if (summary.directories > 0) return '🔎';
  if (summary.unsupported > 0) return '⚠️';
  // A screenshot is a new recorded+parked task (like unsupported); it outranks
  // ♻️/❌ so a screenshot-only message reads as handled, never "no links".
  if (summary.screenshots > 0) return '🖼️';
  if (summary.duplicates > 0) return '♻️';
  return '❌';
}

/** A concise human summary for the channel reply. */
export function replyFor(summary: MessageIngestSummary): string {
  const parts: string[] = [];
  if (summary.ingested > 0) parts.push(`✅ ${summary.ingested} queued`);
  if (summary.directories > 0)
    parts.push(
      `🔎 ${summary.directories} director${summary.directories === 1 ? 'y' : 'ies'}`,
    );
  if (summary.unsupported > 0)
    parts.push(`⚠️ ${summary.unsupported} unsupported (recorded)`);
  if (summary.screenshots > 0)
    parts.push(
      `🖼️ ${summary.screenshots} screenshot${summary.screenshots === 1 ? '' : 's'} recorded — triage on dashboard`,
    );
  if (summary.duplicates > 0) parts.push(`♻️ ${summary.duplicates} duplicate`);
  if (summary.errors > 0) parts.push(`❌ ${summary.errors} error`);
  return parts.length > 0
    ? parts.join(' · ')
    : 'No job links found in that message.';
}

export interface DiscordPollResult {
  enabled: boolean;
  scanned: number;
  processed: number;
}

/**
 * Poll the #ingest channel: for each fresh message with links OR image
 * attachments (any author), classify + ingest, then react (the emoji doubles
 * as the processed marker so re-polls skip it) and post a concise reply.
 * No-op when Discord/channel unset.
 */
export async function runDiscordIngestPoll(
  deps: Deps,
): Promise<DiscordPollResult> {
  const { config, notify } = deps;
  const channelId = config.DISCORD_INGEST_CHANNEL_ID;
  if (!config.DISCORD_ENABLED || !channelId || !notify) {
    return { enabled: false, scanned: 0, processed: 0 };
  }

  const messages = await notify.fetchChannelMessages(channelId, { limit: 50 });
  let processed = 0;
  // Discord returns newest-first; process oldest-first for chronological replies.
  for (const message of [...messages].reverse()) {
    // We do NOT skip by author: links forwarded by another bot/webhook (RSS,
    // link-preview, Simplify) should ingest too, and our own reply messages
    // carry no links so the no-URL guard below drops them. The reaction we add
    // marks a message processed, so re-polls skip it — no self-processing loop.
    if (message.reactions?.some((reaction) => reaction.me)) {
      continue;
    }
    // Process a message with links OR image attachments (a screenshot-only
    // message must never be dropped); skip only when it has neither.
    if (
      extractUrlsFromText(message.content ?? '').length === 0 &&
      imageAttachments(message).length === 0
    ) {
      continue;
    }
    const summary = await ingestMessage(deps, message);
    await notify
      .addReaction(channelId, message.id, reactionFor(summary))
      .catch((error) =>
        console.warn('[sower] discord ingest: react failed:', error),
      );
    await notify
      .postChannelMessage(channelId, replyFor(summary))
      .catch((error) =>
        console.warn('[sower] discord ingest: reply failed:', error),
      );
    processed += 1;
  }
  return { enabled: true, scanned: messages.length, processed };
}
