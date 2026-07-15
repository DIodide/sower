import { canonicalizeUrl } from '@sower/core';
import type { DiscordChannelMessage } from '@sower/notify';
import { detectPlatform, getAdapter, resolveUrl } from '@sower/platforms';
import type { AttachmentOutcome } from './attachment-ingest.js';
import {
  imageAttachments,
  ingestMessageAttachments,
} from './attachment-ingest.js';
import { ingestJob } from './ingest.js';
import { triggerInvestigation } from './investigate-trigger.js';
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
  | {
      url: string;
      kind: 'ingested';
      platform: string;
      jobId: string;
      taskId?: string;
    }
  | {
      url: string;
      kind: 'duplicate';
      jobId: string;
      /** Earliest task on the EXISTING job (null if it somehow has none). */
      taskId: string | null;
      /** Where the existing job originally came from (jobs.source). */
      originalSource: string;
      /** When the existing job was first ingested. */
      originalCreatedAt: Date;
    }
  | { url: string; kind: 'unsupported'; jobId: string; taskId?: string }
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
  /** Per-screenshot outcomes so the reply can link each parked task. */
  screenshotOutcomes: AttachmentOutcome[];
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
        ? {
            url: resolved,
            kind: 'duplicate',
            jobId: result.jobId,
            taskId: result.taskId,
            originalSource: result.originalSource,
            originalCreatedAt: result.originalCreatedAt,
          }
        : {
            url: resolved,
            kind: 'ingested',
            platform: ref.platform,
            jobId: result.jobId,
            taskId: result.taskId,
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
    if (result.duplicate) {
      return {
        url: resolved,
        kind: 'duplicate',
        jobId: result.jobId,
        taskId: result.taskId,
        originalSource: result.originalSource,
        originalCreatedAt: result.originalCreatedAt,
      };
    }
    // Tier 2: fire form discovery for a directly-sent unsupported link ONLY
    // (depth 0). Directory children never trigger — a 50-link directory must
    // not spawn 50 browser Jobs. triggerInvestigation self-gates on the
    // enabled flag and never throws, so the parked task is never at risk.
    if (depth === 0) {
      await triggerInvestigation(deps, result.taskId);
    }
    return {
      url: resolved,
      kind: 'unsupported',
      jobId: result.jobId,
      taskId: result.taskId,
    };
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
    screenshotOutcomes: [],
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
  return {
    ...summary,
    screenshots: screenshots.length,
    screenshotOutcomes: screenshots,
  };
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

/** Discord hard-caps messages at 2000 chars. */
const DISCORD_REPLY_MAX_CHARS = 2000;
/** Itemize at most this many outcomes; the rest collapse into "…+N more". */
const MAX_REPLY_ITEMS = 10;

const easternTimeFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

/** "Jul 13, 3:47 PM ET" — normalized: newer ICU emits U+202F before AM/PM. */
function formatEasternTime(date: Date): string {
  const formatted = easternTimeFormat
    .format(date)
    .replace(/[\u202f\u00a0]/g, ' ');
  return `${formatted} ET`;
}

/**
 * A `task id8` label, linked to the dashboard task page when a base URL is
 * configured; plain backticked id when it isn't (graceful degradation).
 */
function taskLink(taskId: string, dashboardBaseUrl?: string): string {
  const label = `\`${taskId.slice(0, 8)}\``;
  if (!dashboardBaseUrl) return label;
  return `[${label}](${dashboardBaseUrl.replace(/\/+$/, '')}/tasks/${taskId})`;
}

/**
 * A job source rendered as markdown: a GitHub-style `owner/repo` links to
 * github.com, an http(s) URL links to itself, anything else (e.g. `discord`)
 * stays plain text.
 */
function sourceLink(source: string): string {
  if (/^https?:\/\//i.test(source)) return `[${source}](${source})`;
  if (/^[\w.-]+\/[\w.-]+$/.test(source)) {
    return `[${source}](https://github.com/${source})`;
  }
  return source;
}

/** Protocol stripped + truncated so error lines stay compact. */
function shortenUrl(url: string): string {
  const stripped = url.replace(/^https?:\/\//i, '');
  return stripped.length > 60 ? `${stripped.slice(0, 59)}…` : stripped;
}

function lineForOutcome(
  outcome: UrlOutcome,
  dashboardBaseUrl?: string,
): string {
  switch (outcome.kind) {
    case 'ingested': {
      const ref = outcome.taskId
        ? taskLink(outcome.taskId, dashboardBaseUrl)
        : shortenUrl(outcome.url);
      return `✅ ${ref} queued · ${outcome.platform}`;
    }
    case 'unsupported': {
      const ref = outcome.taskId
        ? taskLink(outcome.taskId, dashboardBaseUrl)
        : shortenUrl(outcome.url);
      return `⚠️ recorded (unsupported) → ${ref}`;
    }
    case 'duplicate': {
      const target =
        outcome.taskId === null
          ? ''
          : ` of ${taskLink(outcome.taskId, dashboardBaseUrl)}`;
      return `♻️ duplicate${target} · originally added ${formatEasternTime(outcome.originalCreatedAt)} via ${sourceLink(outcome.originalSource)}`;
    }
    case 'directory': {
      let queued = 0;
      let recorded = 0;
      let duplicates = 0;
      let errors = 0;
      for (const child of outcome.children) {
        if (child.kind === 'ingested') queued += 1;
        else if (child.kind === 'unsupported') recorded += 1;
        else if (child.kind === 'duplicate') duplicates += 1;
        else if (child.kind === 'error') errors += 1;
      }
      const extras = [
        duplicates > 0 ? `, ${duplicates} duplicate` : '',
        errors > 0 ? `, ${errors} error` : '',
      ].join('');
      return `🔎 ${outcome.children.length} links from a directory (${queued} queued, ${recorded} recorded${extras})`;
    }
    case 'error':
      return `❌ ${shortenUrl(outcome.url)}: ${outcome.error}`;
  }
}

function lineForScreenshot(
  outcome: AttachmentOutcome,
  dashboardBaseUrl?: string,
): string {
  const ref =
    outcome.taskId === null
      ? `\`${outcome.jobId.slice(0, 8)}\``
      : taskLink(outcome.taskId, dashboardBaseUrl);
  const suffix = outcome.stored ? '' : ' (image not stored)';
  return `🖼️ screenshot recorded → ${ref}${suffix}`;
}

/**
 * A per-outcome reply for the channel: every outcome gets one line linking it
 * to its dashboard task (markdown links when DASHBOARD_BASE_URL is set, plain
 * backticked ids otherwise), capped at MAX_REPLY_ITEMS lines + a "…+N more"
 * summary so the whole message stays under Discord's 2000-char limit.
 */
export function replyFor(
  summary: MessageIngestSummary,
  dashboardBaseUrl?: string,
): string {
  const lines = summary.outcomes.map((outcome) =>
    lineForOutcome(outcome, dashboardBaseUrl),
  );
  for (const shot of summary.screenshotOutcomes) {
    lines.push(lineForScreenshot(shot, dashboardBaseUrl));
  }
  // A summary built without per-screenshot outcomes still reports the count.
  if (summary.screenshots > summary.screenshotOutcomes.length) {
    const extra = summary.screenshots - summary.screenshotOutcomes.length;
    lines.push(
      `🖼️ ${extra} screenshot${extra === 1 ? '' : 's'} recorded — triage on dashboard`,
    );
  }
  if (lines.length === 0) return 'No job links found in that message.';

  const shown = lines.slice(0, MAX_REPLY_ITEMS);
  let omitted = lines.length - shown.length;
  const render = (): string =>
    omitted > 0 ? `${shown.join('\n')}\n…+${omitted} more` : shown.join('\n');
  let reply = render();
  // Even 10 lines can exceed the cap (long links): drop items until it fits.
  while (reply.length > DISCORD_REPLY_MAX_CHARS && shown.length > 1) {
    shown.pop();
    omitted += 1;
    reply = render();
  }
  if (reply.length > DISCORD_REPLY_MAX_CHARS) {
    // Pathological single line: hard-truncate as a last resort.
    reply = `${reply.slice(0, DISCORD_REPLY_MAX_CHARS - 1)}…`;
  }
  return reply;
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
      .postChannelMessage(
        channelId,
        replyFor(summary, config.DASHBOARD_BASE_URL),
      )
      .catch((error) =>
        console.warn('[sower] discord ingest: reply failed:', error),
      );
    processed += 1;
  }
  return { enabled: true, scanned: messages.length, processed };
}
