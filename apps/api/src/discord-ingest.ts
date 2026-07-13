import { canonicalizeUrl } from '@sower/core';
import { detectPlatform, getAdapter, resolveUrl } from '@sower/platforms';
import { ingestJob } from './ingest.js';
import { extractUrlsFromText, fetchJobLinks } from './link-extract.js';
import type { Deps } from './types.js';

/**
 * Ingest job links that arrive via Discord. The classifier is ingress-agnostic;
 * `runDiscordIngestPoll` is the channel adapter over it.
 *
 * The one invariant: NOTHING is silently dropped. Every URL you send resolves
 * to exactly one outcome — ingested (supported), recorded-and-parked
 * (unsupported, via ingestJob's unknown-platform path), expanded into child
 * links (a directory), or reported as an error — and the reply itemizes it.
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
  outcomes: UrlOutcome[];
}

/** Classify one URL and route it: supported→ingest, unknown→expand-or-record. */
async function classifyAndIngest(
  deps: Deps,
  url: string,
  depth: number,
): Promise<UrlOutcome> {
  try {
    const resolved = await resolveUrl(url);
    const ref = detectPlatform(canonicalizeUrl(resolved));

    // Supported platform with a resolvable tenant → normal ingest (enqueues).
    if (getAdapter(ref.platform) && ref.tenant !== null) {
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

/** Emoji that best captures a message's result (the "processed" marker too). */
export function reactionFor(summary: MessageIngestSummary): string {
  if (summary.ingested > 0) return '✅';
  if (summary.directories > 0) return '🔎';
  if (summary.unsupported > 0) return '⚠️';
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
 * Poll the #ingest channel: for each fresh user message with links, classify +
 * ingest, then react (the emoji doubles as the processed marker so re-polls
 * skip it) and post a concise reply. No-op when Discord/the channel is unset.
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
    if (message.author?.bot) {
      continue;
    }
    // Any existing bot reaction means we already handled this message.
    if (message.reactions?.some((reaction) => reaction.me)) {
      continue;
    }
    if (extractUrlsFromText(message.content ?? '').length === 0) {
      continue;
    }
    const summary = await ingestMessageLinks(deps, message.content);
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
