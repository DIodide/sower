import type { PlatformRef } from '@sower/core';
import { canonicalizeUrl } from '@sower/core';
import { applicationTasks } from '@sower/db';
import type {
  DiscordActionRow,
  DiscordChannelMessage,
  DiscordEmbed,
} from '@sower/notify';
import {
  deriveGreenhouseTenant,
  detectPlatform,
  getAdapter,
  resolveUrl,
} from '@sower/platforms';
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
  trailingNumericJobId,
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
/** Default jobs.source when no ingress overrides it (the Discord poll). */
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
  /**
   * URLs beyond the MAX_URLS_PER_MESSAGE cap that were NOT processed (0 or
   * absent when everything fit). Surfaced so ingresses can tell the user
   * instead of silently dropping links.
   */
  truncatedUrls?: number;
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

/**
 * The job id when a ref is greenhouse-with-id-but-no-tenant (gh_jid on a
 * custom domain) — the shape the verified tenant probe can resolve.
 */
function tenantlessGreenhouseJobId(ref: PlatformRef): string | null {
  return ref.platform === 'greenhouse' &&
    ref.tenant === null &&
    ref.externalId !== null
    ? ref.externalId
    : null;
}

/** Ingest a supported-platform URL and map the result to its outcome. */
async function ingestSupported(
  deps: Deps,
  url: string,
  platform: string,
  source: string,
): Promise<UrlOutcome> {
  const result = await ingestJob(deps, { url, source });
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
  source: string,
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
      return await ingestSupported(deps, unwrapped, preRef.platform, source);
    }

    const resolved = await resolveUrl(unwrapped);
    const ref = detectPlatform(canonicalizeUrl(resolved));

    // Supported platform with a resolvable tenant → normal ingest (enqueues).
    if (isSupportedJobRef(ref, resolved)) {
      return await ingestSupported(deps, resolved, ref.platform, source);
    }

    // Still unknown at the top level → fetch the page ONCE and inspect it,
    // cheapest evidence first: (1) sniff the HTML for a greenhouse job
    // embedded on a custom domain (free — no extra requests), (2) probe the
    // fixed greenhouse boards API for a VERIFIED tenant when the URL pinned a
    // gh_jid without one (a few API GETs — covers JS-rendered pages the sniff
    // cannot see through, e.g. akunacapital.com) OR when an unsupported URL's
    // final path segment carries a numeric job id (databricks.com's slug-id
    // URLs), (3) treat the page as a directory of job links, (4) record +
    // park below. A sniff or probe hit ingests the canonical board URL so it
    // dedupes with board-hosted pastes.
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
          return await ingestSupported(deps, canonical, 'greenhouse', source);
        }
      }
      // Sniff missed (or the page fetch failed): when the pre- or post-resolve
      // ref was greenhouse-with-id-but-no-tenant, the probe can still verify
      // the tenant straight from the boards API. Only a VERIFIED hit (200 +
      // matching job id) ingests; null falls through to directory/park.
      const probeJobId =
        tenantlessGreenhouseJobId(ref) ?? tenantlessGreenhouseJobId(preRef);
      if (probeJobId !== null) {
        const tenant = await deriveGreenhouseTenant(resolved, probeJobId);
        if (tenant !== null) {
          const canonical = `https://job-boards.greenhouse.io/${tenant}/jobs/${probeJobId}`;
          return await ingestSupported(deps, canonical, 'greenhouse', source);
        }
      }
      // No gh_jid anywhere, but some greenhouse tenants render postings on
      // their own domain with ONLY the numeric job id at the tail of the
      // path (databricks.com/…/university-recruiting/<slug>-7011263002).
      // When the resolved URL is not any supported platform and its final
      // path segment carries such a candidate id, run the SAME verified
      // tenant probe with it. Verified-only: a hit ingests the canonical
      // board URL exactly like the gh_jid probe above; a false candidate
      // costs a couple of 404 probes and falls through unchanged.
      if (probeJobId === null && ref.platform === 'unknown') {
        const candidateId = trailingNumericJobId(resolved);
        if (candidateId !== null) {
          const tenant = await deriveGreenhouseTenant(resolved, candidateId);
          if (tenant !== null) {
            const canonical = `https://job-boards.greenhouse.io/${tenant}/jobs/${candidateId}`;
            return await ingestSupported(deps, canonical, 'greenhouse', source);
          }
        }
      }
      if (page) {
        const links = extractJobLinks(page.html, page.url);
        if (links.length > 0) {
          const children = await classifyMany(deps, links, source, depth + 1);
          return { url: resolved, kind: 'directory', children };
        }
      }
    }

    // A single unsupported job (or an unparseable page): record + park it so
    // it's captured and visible, never lost. ingestJob parks unknown platforms.
    const result = await ingestJob(deps, { url: resolved, source });
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
    // Tier 2: fire form discovery for depth-0 unsupported links ONLY — a
    // directly-sent link or a listing-expansion child (first-class, exactly
    // as if the user had pasted it). Directory children (depth 1) never
    // trigger — a 50-link directory must not spawn 50 browser Jobs. Note the
    // duplicate return above happens BEFORE this block: an already-known URL
    // (e.g. a listing linking back to itself) can never re-fire an
    // investigation, which is what damps expansion loops. triggerInvestigation
    // self-gates on the enabled flag and never throws, so the parked task is
    // never at risk.
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

/**
 * Classify + ingest a batch of URLs at a fixed depth, capped at
 * MAX_DIRECTORY_LINKS. Extracted from the directory-expansion loop (which
 * enters at CHILD depth — the default, 1: no page fetch, no nested
 * expansion, no per-link investigation fan-out). Also the LISTING-EXPANSION
 * entry point: the investigation-result endpoint feeds the job links the
 * browser agent extracted from a rendered listings page through here at TOP
 * depth (0), so each child gets the full first-class treatment — sniff/probe,
 * directory logic, and Tier-2 form discovery for unsupported children —
 * exactly as if the user had pasted the links themselves. Dedupe (the early
 * duplicate return in classifyAndIngest) plus this cap keep that bounded.
 */
export async function classifyMany(
  deps: Deps,
  urls: string[],
  source: string,
  depth = 1,
): Promise<UrlOutcome[]> {
  const outcomes: UrlOutcome[] = [];
  for (const url of urls.slice(0, MAX_DIRECTORY_LINKS)) {
    outcomes.push(await classifyAndIngest(deps, url, depth, source));
  }
  return outcomes;
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

/**
 * Extract every URL from a text blob and classify+ingest each. Ingress-
 * agnostic: `source` stamps jobs.source for provenance ('discord' for the
 * channel poll, 'manual' for the dashboard paste box) and changes nothing
 * else about classification, dedupe, or parking.
 */
export async function ingestMessageLinks(
  deps: Deps,
  text: string,
  source: string = SOURCE,
): Promise<MessageIngestSummary> {
  const found = extractUrlsFromText(text).filter(
    (url) => !isSelfReferentialUrl(url, deps.config),
  );
  const urls = found.slice(0, MAX_URLS_PER_MESSAGE);
  const outcomes: UrlOutcome[] = [];
  for (const url of urls) {
    outcomes.push(await classifyAndIngest(deps, url, 0, source));
  }
  const summary = summarize(urls.length, outcomes);
  summary.truncatedUrls = found.length - urls.length;
  return summary;
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
 * Exported for deadline alerts, whose labels embed in links the same way.
 */
export function escapeLabel(text: string): string {
  return (
    text
      .replace(/[\\`*_~[\]()]/g, '\\$&')
      // Neutralize Discord pings (@everyone/@here/<@id>): a zero-width
      // space after '@' breaks mention parsing without visible change.
      // Label text can come from attacker-controlled email subjects and
      // scraped pages, and #alerts pings the user by explicit mention —
      // injected mentions must never work.
      .replace(/@/g, '@\u200b')
  );
}

/** Scheme + leading `www.` stripped, trailing slash dropped, ~48-char cap.
 *  Exported for deadline alerts (the same label-of-last-resort rule). */
export function shortenUrlForLabel(url: string): string {
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
 * One reply line per outcome, linking each to its dashboard task under a
 * human-meaningful label (markdown links when DASHBOARD_BASE_URL is set,
 * bold labels otherwise — never the raw task id). Shared by the plain reply
 * renderer and the embed reply's description.
 */
export function replyLines(
  summary: MessageIngestSummary,
  dashboardBaseUrl?: string,
): string[] {
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
  return lines;
}

/**
 * A per-outcome reply for the channel, capped at MAX_REPLY_ITEMS lines + a
 * "…+N more" summary so the whole message stays under Discord's 2000-char
 * limit. Kept as the plain-text fallback beside the embed reply.
 */
export function replyFor(
  summary: MessageIngestSummary,
  dashboardBaseUrl?: string,
): string {
  const lines = replyLines(summary, dashboardBaseUrl);
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

/** Neutral blurple accent for the #ingest reply embed. */
export const INGEST_EMBED_COLOR = 0x5865f2;
/** The embed field quoting the user's original (possibly deleted) message. */
export const INGEST_QUOTE_FIELD = 'Your message';
/** Discord embed hard caps: title 256, field value 1024. */
const EMBED_TITLE_MAX = 256;
const EMBED_FIELD_VALUE_MAX = 1024;

/**
 * The verbatim quote of the user's original message for the embed field, or
 * null when it cannot be quoted (blank, or over the 1024-char field cap) —
 * null also means the original message must be left in place.
 */
export function quotedMessageValue(content: string | undefined): string | null {
  if (!content || content.trim() === '') return null;
  return content.length <= EMBED_FIELD_VALUE_MAX ? content : null;
}

/**
 * The single task the reply's action buttons act on: exactly one outcome
 * that created (ingested/unsupported/screenshot) or matched (duplicate)
 * exactly one task. Multi-link, directory, and error outcomes get none.
 */
export function singleActionTaskId(
  summary: MessageIngestSummary,
): string | null {
  if (summary.outcomes.length + summary.screenshotOutcomes.length !== 1) {
    return null;
  }
  const outcome = summary.outcomes[0];
  if (outcome) {
    if (outcome.kind === 'ingested' || outcome.kind === 'unsupported') {
      return outcome.taskId ?? null;
    }
    if (outcome.kind === 'duplicate') {
      return outcome.taskId;
    }
    return null;
  }
  return summary.screenshotOutcomes[0]?.taskId ?? null;
}

/**
 * The embed title at post time: outcome emoji + a compact label. Company —
 * role is never known this early (the ATS parse runs async), so a lone
 * outcome shows its shortened URL / filename and refreshIngestReply
 * upgrades the title once the parse lands; multiple outcomes show a tally.
 * Embed titles render no markdown, so nothing is escaped here.
 */
export function ingestReplyTitle(summary: MessageIngestSummary): string {
  const emoji = reactionFor(summary);
  if (summary.outcomes.length + summary.screenshotOutcomes.length === 1) {
    const outcome = summary.outcomes[0];
    const label = outcome
      ? shortenUrlForLabel(outcome.url)
      : (summary.screenshotOutcomes[0]?.filename ?? '');
    if (label !== '') {
      return `${emoji} ${label}`;
    }
  }
  const parts: string[] = [];
  if (summary.ingested > 0) parts.push(`${summary.ingested} queued`);
  if (summary.duplicates > 0) {
    parts.push(
      `${summary.duplicates} duplicate${summary.duplicates === 1 ? '' : 's'}`,
    );
  }
  if (summary.unsupported > 0) parts.push(`${summary.unsupported} recorded`);
  if (summary.directories > 0) {
    parts.push(
      `${summary.directories} director${summary.directories === 1 ? 'y' : 'ies'}`,
    );
  }
  if (summary.screenshots > 0) {
    parts.push(
      `${summary.screenshots} screenshot${summary.screenshots === 1 ? '' : 's'}`,
    );
  }
  if (summary.errors > 0) {
    parts.push(`${summary.errors} error${summary.errors === 1 ? '' : 's'}`);
  }
  return parts.length === 0
    ? `${emoji} No job links found`
    : `${emoji} ${parts.join(' · ')}`;
}

/**
 * The #ingest reply embed: title = the outcome line, description = the
 * per-outcome lines (renderReplyLines keeps it under 2000 chars, well
 * inside the 4096 description cap), plus the quoted-original field when the
 * quote fits. Worst case ≈ 256 + 2000 + 1024 chars — comfortably under
 * Discord's 6000-char embed total, so no further shrinking is needed.
 */
export function buildIngestEmbed(
  title: string,
  lines: string[],
  quote?: string,
): DiscordEmbed {
  const embed: DiscordEmbed = {
    title:
      title.length > EMBED_TITLE_MAX
        ? `${title.slice(0, EMBED_TITLE_MAX - 1)}…`
        : title,
    color: INGEST_EMBED_COLOR,
    description:
      lines.length === 0
        ? 'No job links found in that message.'
        : renderReplyLines(lines),
  };
  if (
    quote !== undefined &&
    quote !== '' &&
    quote.length <= EMBED_FIELD_VALUE_MAX
  ) {
    embed.fields = [{ name: INGEST_QUOTE_FIELD, value: quote }];
  }
  return embed;
}

/** Discord button styles: 3 = green/success, 4 = red/danger. */
const BUTTON_STYLE_SUCCESS = 3;
const BUTTON_STYLE_DANGER = 4;

/**
 * The action row for a single-task reply: Mark as Complete / Discard,
 * custom_ids handled by POST /discord/interactions (ingest_mark:/
 * ingest_discard:, mirroring the approval card's approve:/reject:).
 */
export function ingestActionRows(taskId: string): DiscordActionRow[] {
  return [
    {
      type: 1,
      components: [
        {
          type: 2,
          style: BUTTON_STYLE_SUCCESS,
          label: 'Mark as Complete',
          custom_id: `ingest_mark:${taskId}`,
        },
        {
          type: 2,
          style: BUTTON_STYLE_DANGER,
          label: 'Discard',
          custom_id: `ingest_discard:${taskId}`,
        },
      ],
    },
  ];
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

/** 403 (missing Manage Messages) is a config gap: warned once per process. */
let warnedDeleteForbidden = false;

/**
 * Delete the user's original #ingest message once its content lives on in
 * the reply embed. Best-effort by contract: the bot did not author the
 * message, so a missing Manage Messages grant surfaces as a 403 — logged
 * once, the original (and its reaction) simply stays. NEVER throws.
 */
async function deleteOriginalMessage(
  notify: NonNullable<Deps['notify']>,
  channelId: string,
  messageId: string,
): Promise<void> {
  try {
    await notify.deleteChannelMessage(channelId, messageId);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const forbidden = /\b403\b/.test(detail);
    if (forbidden && warnedDeleteForbidden) {
      return;
    }
    if (forbidden) {
      warnedDeleteForbidden = true;
    }
    console.warn(
      '[sower] discord ingest: deleting the original message failed (leaving it in place):',
      detail,
    );
  }
}

/**
 * Poll the #ingest channel: for each fresh message with links OR image
 * attachments (any author), classify + ingest, then react (the emoji doubles
 * as the processed marker so re-polls skip it) and post an embed reply
 * (quoting + deleting the original when it fits, with action buttons for a
 * lone task). No-op when Discord/channel unset.
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
    const embed = buildIngestEmbed(
      ingestReplyTitle(summary),
      replyLines(summary, config.DASHBOARD_BASE_URL),
      quotedMessageValue(message.content) ?? undefined,
    );
    const actionTaskId = singleActionTaskId(summary);
    const reply = await notify
      .postChannelMessage(channelId, {
        embeds: [embed],
        ...(actionTaskId === null
          ? {}
          : { components: ingestActionRows(actionTaskId) }),
      })
      .catch((error) => {
        console.warn('[sower] discord ingest: reply failed:', error);
        return null;
      });
    // The original message is deleted ONLY when its full content survives as
    // the embed's quote field AND the embed reply actually posted — and never
    // when it carries attachments (deleting would kill the CDN URLs the
    // screenshot tasks/vault fallbacks still point at). A kept original keeps
    // its reaction as the processed marker; a deleted one can't re-poll.
    if (
      reply?.id &&
      embed.fields?.some((field) => field.name === INGEST_QUOTE_FIELD) &&
      (message.attachments ?? []).length === 0
    ) {
      await deleteOriginalMessage(notify, channelId, message.id);
    }
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
