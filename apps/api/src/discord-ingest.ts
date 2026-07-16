import type { PlatformRef } from '@sower/core';
import { canonicalizeUrl } from '@sower/core';
import { applicationTasks } from '@sower/db';
import type { DiscordChannelMessage } from '@sower/notify';
import { detectPlatform, getAdapter, resolveUrl } from '@sower/platforms';
import { inArray } from 'drizzle-orm';
import type { AttachmentOutcome } from './attachment-ingest.js';
import {
  imageAttachments,
  ingestMessageAttachments,
} from './attachment-ingest.js';
import { ingestJob } from './ingest.js';
import { refreshIngestReply } from './ingest-reply.js';
import { triggerInvestigation } from './investigate-trigger.js';
import {
  extractJobLinks,
  extractUrlsFromText,
  fetchPageHtml,
  isIngestableJobUrl,
  sniffGreenhouseJob,
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
  | {
      url: string;
      kind: 'unsupported';
      jobId: string;
      taskId?: string;
      /**
       * True when Tier-2 form discovery was fired for this freshly parked
       * task, so the reply renders "discovering form…" instead of a plain
       * "recorded (unsupported)" (kept honest until the edit lands).
       */
      investigating?: boolean;
    }
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

/** True when detectPlatform found a posting an adapter can discover as-is. */
function isSupportedJobRef(ref: PlatformRef, url: string): boolean {
  return (
    getAdapter(ref.platform) !== null &&
    ref.tenant !== null &&
    isIngestableJobUrl(ref.platform, url)
  );
}

/** Ingest a supported-platform URL and map the result to its outcome. */
async function ingestSupported(
  deps: Deps,
  url: string,
  platform: string,
): Promise<UrlOutcome> {
  const result = await ingestJob(deps, { url, source: SOURCE });
  return result.duplicate
    ? {
        url,
        kind: 'duplicate',
        jobId: result.jobId,
        taskId: result.taskId,
        originalSource: result.originalSource,
        originalCreatedAt: result.originalCreatedAt,
      }
    : {
        url,
        kind: 'ingested',
        platform,
        jobId: result.jobId,
        taskId: result.taskId,
      };
}

/**
 * Classify one URL and route it, in order: supported-pre-resolve →
 * resolve+detect → greenhouse-sniff → directory-expand → record+park.
 */
async function classifyAndIngest(
  deps: Deps,
  url: string,
  depth: number,
): Promise<UrlOutcome> {
  try {
    const unwrapped = unwrapRedirectShim(url);

    // Detect BEFORE resolving: a supported ATS URL carries tenant+id, and its
    // adapter discovers via the platform API, so following redirects adds
    // nothing — and LOSES the identity when the board redirects to the
    // company's own domain (job-boards.greenhouse.io/stripe/jobs/… →
    // stripe.com/jobs/…). Shorteners (t.co, lnkd.in) detect as unknown here
    // and still resolve below.
    const preRef = detectPlatform(canonicalizeUrl(unwrapped));
    if (isSupportedJobRef(preRef, unwrapped)) {
      return await ingestSupported(deps, unwrapped, preRef.platform);
    }

    const resolved = await resolveUrl(unwrapped);
    const ref = detectPlatform(canonicalizeUrl(resolved));

    // Supported platform with a resolvable tenant → normal ingest (enqueues).
    if (isSupportedJobRef(ref, resolved)) {
      return await ingestSupported(deps, resolved, ref.platform);
    }

    // Still unknown at the top level → fetch the page ONCE and inspect it:
    // first sniff for a greenhouse job embedded on a custom domain (ingest
    // the canonical board URL so it dedupes with board-hosted pastes), then
    // fall back to treating the page as a directory of job links.
    if (depth === 0) {
      const page = await fetchPageHtml(resolved);
      if (page) {
        // The gh_jid marker may live on the fetched page URL, the resolved
        // URL, or the original one — redirects routinely strip it (live:
        // stripe.com/jobs/search?gh_jid=N 302s to a slug URL without it).
        // The sniff is pure, so try each candidate URL against the HTML.
        const sniffed = [...new Set([page.url, resolved, unwrapped])]
          .map((candidate) => sniffGreenhouseJob(page.html, candidate))
          .find((hit) => hit !== null);
        if (sniffed) {
          const canonical = `https://job-boards.greenhouse.io/${sniffed.tenant}/jobs/${sniffed.jobId}`;
          return await ingestSupported(deps, canonical, 'greenhouse');
        }
        const links = extractJobLinks(page.html, page.url);
        if (links.length > 0) {
          const children: UrlOutcome[] = [];
          for (const link of links.slice(0, MAX_DIRECTORY_LINKS)) {
            children.push(await classifyAndIngest(deps, link, depth + 1));
          }
          return { url: resolved, kind: 'directory', children };
        }
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
    let investigating = false;
    if (depth === 0) {
      investigating = await triggerInvestigation(deps, result.taskId);
    }
    return {
      url: resolved,
      kind: 'unsupported',
      jobId: result.jobId,
      taskId: result.taskId,
      investigating,
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

/**
 * Hosts we must NEVER ingest as "job links": our own dashboard (its task links
 * appear in the bot's replies and resolve to an IAP sign-in page) and the
 * Google sign-in host they redirect to. Belt to the app-id self-skip in the
 * poll — even a human-pasted dashboard link should never become a job.
 */
function isSelfReferentialUrl(
  url: string,
  config: Deps['config'] | undefined,
): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'accounts.google.com') return true;
  if (config?.DASHBOARD_BASE_URL) {
    try {
      return host === new URL(config.DASHBOARD_BASE_URL).hostname.toLowerCase();
    } catch {
      // malformed config — fall through
    }
  }
  return false;
}

/** Extract every URL from a message and classify+ingest each. */
export async function ingestMessageLinks(
  deps: Deps,
  text: string,
): Promise<MessageIngestSummary> {
  const urls = extractUrlsFromText(text)
    .filter((url) => !isSelfReferentialUrl(url, deps.config))
    .slice(0, MAX_URLS_PER_MESSAGE);
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

const easternDateFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  month: 'short',
  day: 'numeric',
});

/** "Jul 15" — the compact ET ingest date each task line carries. */
export function formatEasternDate(date: Date): string {
  return easternDateFormat.format(date);
}

/** Longest a URL-fallback label gets before it is truncated with `…`. */
const MAX_URL_LABEL_CHARS = 48;

/**
 * Escape markdown-breaking characters (brackets, backticks, emphasis, …) so a
 * job title can never corrupt the `[label](url)` link it is embedded in.
 */
function escapeLabel(text: string): string {
  return text.replace(/[\\`*_~[\]()]/g, '\\$&');
}

/** Scheme + leading `www.` stripped, trailing slash dropped, ~48-char cap. */
function shortenUrlForLabel(url: string): string {
  const stripped = url
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .replace(/\/+$/, '');
  return stripped.length > MAX_URL_LABEL_CHARS
    ? `${stripped.slice(0, MAX_URL_LABEL_CHARS - 1)}…`
    : stripped;
}

/**
 * The human-meaningful visible text for a task link, in priority order:
 * `Title · Company` → `Title` → `Company` → the shortened job URL. NEVER the
 * task UUID — an id tells a human nothing. Markdown-escaped so a title with
 * `]`/backticks/etc. cannot break the surrounding link.
 */
export function taskLabel(parts: {
  title?: string | null;
  company?: string | null;
  url: string;
}): string {
  const title = parts.title?.trim();
  const company = parts.company?.trim();
  const label =
    title && company
      ? `${title} · ${company}`
      : title || company || shortenUrlForLabel(parts.url);
  return escapeLabel(label);
}

/**
 * The task reference on a reply line: `[<label>](<dashboard>/tasks/<id>)`,
 * or the bold label alone when no dashboard base URL is configured. The task
 * id is only ever the link TARGET — the visible text is always the label.
 * Shared with refreshIngestReply so edited replies keep identical links.
 */
export function taskLink(
  taskId: string,
  label: string,
  dashboardBaseUrl?: string,
): string {
  if (!dashboardBaseUrl) return `**${label}**`;
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
  // A fresh ingest knows no title/company at post time (the ATS parse runs
  // async), so the label is the shortened URL; refreshIngestReply upgrades it
  // to "Title · Company" once the parse lands. The ingest date IS now.
  const today = formatEasternDate(new Date());
  switch (outcome.kind) {
    case 'ingested': {
      const label = taskLabel({ url: outcome.url });
      const ref = outcome.taskId
        ? taskLink(outcome.taskId, label, dashboardBaseUrl)
        : label;
      return `✅ ${ref} · queued · ${outcome.platform} · ${today}`;
    }
    case 'unsupported': {
      const label = taskLabel({ url: outcome.url });
      const ref = outcome.taskId
        ? taskLink(outcome.taskId, label, dashboardBaseUrl)
        : label;
      // A fired form discovery renders as in-progress; refreshIngestReply
      // edits this line once the investigator Job reports back.
      return outcome.investigating
        ? `🔎 ${ref} · discovering form… · ${today}`
        : `⚠️ ${ref} · recorded (unsupported) · ${today}`;
    }
    case 'duplicate': {
      const label = taskLabel({ url: outcome.url });
      const ref =
        outcome.taskId === null
          ? label
          : taskLink(outcome.taskId, label, dashboardBaseUrl);
      return `♻️ ${ref} · duplicate — originally added ${formatEasternTime(outcome.originalCreatedAt)} via ${sourceLink(outcome.originalSource)}`;
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
  // The filename is the only human-meaningful handle a screenshot has at post
  // time — never the job/task UUID.
  const label = escapeLabel(outcome.filename);
  const ref =
    outcome.taskId === null
      ? label
      : taskLink(outcome.taskId, label, dashboardBaseUrl);
  const suffix = outcome.stored ? '' : ' (image not stored)';
  return `🖼️ ${ref} · screenshot recorded${suffix} · ${formatEasternDate(new Date())}`;
}

/**
 * A per-outcome reply for the channel: every outcome gets one line linking it
 * to its dashboard task under a human-meaningful label (markdown links when
 * DASHBOARD_BASE_URL is set, bold labels otherwise — never the raw task id),
 * capped at MAX_REPLY_ITEMS lines + a "…+N more" summary so the whole message
 * stays under Discord's 2000-char limit.
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
  return renderReplyLines(lines);
}

/**
 * Join per-task lines into one Discord message: at most MAX_REPLY_ITEMS
 * itemized lines + a "…+N more" summary, always under the 2000-char cap.
 * Shared by replyFor (the initial post) and refreshIngestReply (the edit).
 */
export function renderReplyLines(lines: string[]): string {
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
 * The tasks a message's reply announced (fresh tasks only — duplicates point
 * at tasks announced elsewhere, and directory children collapse into one
 * summary line the refresh could not re-render per task). These are the rows
 * that get the reply's channel/message id so refreshIngestReply can edit it.
 */
export function announcedTaskIds(summary: MessageIngestSummary): string[] {
  const ids = new Set<string>();
  for (const outcome of summary.outcomes) {
    if (
      (outcome.kind === 'ingested' || outcome.kind === 'unsupported') &&
      outcome.taskId
    ) {
      ids.add(outcome.taskId);
    }
  }
  for (const shot of summary.screenshotOutcomes) {
    if (shot.taskId !== null) {
      ids.add(shot.taskId);
    }
  }
  return [...ids];
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
    // Skip OUR OWN messages. The bot's replies embed dashboard task links, so
    // processing them would re-ingest those links (which resolve to an IAP
    // sign-in page) and self-feed a loop every poll. We skip by app id, NOT by
    // the generic bot flag — links forwarded by OTHER bots/webhooks (RSS,
    // link-preview, Simplify) should still ingest.
    if (message.author?.id === config.DISCORD_APP_ID) {
      continue;
    }
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
    const reply = await notify
      .postChannelMessage(
        channelId,
        replyFor(summary, config.DASHBOARD_BASE_URL),
      )
      .catch((error) => {
        console.warn('[sower] discord ingest: reply failed:', error);
        return null;
      });
    // Remember which reply announced each fresh task, so refreshIngestReply
    // can re-render + edit it as tasks advance. Best-effort: a failed write
    // must never fail the poll (the tasks themselves are already safe).
    if (reply?.id) {
      const taskIds = announcedTaskIds(summary);
      if (taskIds.length > 0) {
        try {
          await deps.db
            .update(applicationTasks)
            .set({ ingestChannelId: channelId, ingestMessageId: reply.id })
            .where(inArray(applicationTasks.id, taskIds));
          // Race fix: a fast ATS parse can finish BEFORE this write lands, so
          // processTask's post-parse refresh may have already no-op'd (no
          // message id yet), leaving the reply stuck on the URL label. One
          // refresh now — with the id stored — upgrades to "Title · Company"
          // if the parse already completed; if not, processTask's later refresh
          // (id now present) does. One call re-renders all of the message's
          // sibling task lines, so a single task id suffices.
          const firstTaskId = taskIds[0];
          if (firstTaskId) {
            await refreshIngestReply(deps, firstTaskId);
          }
        } catch (error) {
          console.warn(
            '[sower] discord ingest: storing reply ref failed:',
            error,
          );
        }
      }
    }
    processed += 1;
  }
  return { enabled: true, scanned: messages.length, processed };
}
