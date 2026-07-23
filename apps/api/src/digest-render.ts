import {
  FOLLOWUP_STATE_LABELS,
  OPEN_FOLLOWUP_STATES,
  TASK_PRIORITY_LABELS,
} from '@sower/core';
import type { DiscordEmbed } from '@sower/notify';
import type { DigestInPlayItem, WeeklyDigest } from './digest.js';
import { escapeLabel, formatEasternDate } from './discord-ingest.js';

/**
 * Weekly-digest renderers. Everything interpolated (companies, titles) is
 * scraped/email-derived and therefore UNTRUSTED: the Discord renderer routes
 * every label through escapeLabel (markdown + mention neutralization) and
 * the email renderer HTML-escapes every value. Task/follow-up ids only ever
 * appear as link targets, never as visible text.
 */

/** Discord hard-caps at 2000; the digest stays under this with headroom. */
const DISCORD_DIGEST_MAX_CHARS = 1900;

/** Item lines a section renders before collapsing into "… and N more". */
const MAX_SECTION_ITEMS = 5;

/**
 * The public dashboard the EMAIL's links point at — always absolute (mail
 * clients have no base URL to resolve against).
 */
export const EMAIL_DASHBOARD_BASE_URL = 'https://jobs.ibraheemamin.dev';

/** `Company — Title` with the lone known part as fallback; never an id. */
function companyTitleLabel(
  company: string | null,
  title: string | null,
): string {
  const c = company?.trim();
  const t = title?.trim();
  return c && t ? `${c} — ${t}` : c || t || 'untitled role';
}

/** A follow-up line's label: its own title, suffixed with the company. */
function followupLabel(item: DigestInPlayItem): string {
  const company = item.company?.trim();
  return company ? `${item.title} — ${company}` : item.title;
}

/** `[label](base+path)`, or the bold label when no base URL is configured. */
function markdownLink(label: string, path: string, base?: string): string {
  if (!base) {
    return `**${label}**`;
  }
  return `[${label}](${base}${path})`;
}

interface DiscordSection {
  header: string;
  items: string[];
}

/** A section capped at `limit` item lines, the rest as "… and N more". */
function renderSection(section: DiscordSection, limit: number): string[] {
  const shown = section.items.slice(0, limit);
  const rest = section.items.length - shown.length;
  return [
    section.header,
    ...shown,
    ...(rest > 0 ? [`… and ${rest} more`] : []),
  ];
}

/**
 * The six digest sections as Discord markdown (headers with counts, one
 * bullet per item), shared by the plain-text renderer and the embed
 * renderer — both keep identical per-section lines.
 */
function buildDiscordSections(
  digest: WeeklyDigest,
  base?: string,
): DiscordSection[] {
  const link = (
    company: string | null,
    title: string | null,
    path: string,
  ): string =>
    markdownLink(escapeLabel(companyTitleLabel(company, title)), path, base);

  return [
    {
      header: `📤 **Submitted** (${digest.submitted.count})`,
      items: digest.submitted.items.map(
        (item) =>
          `• ${link(item.company, item.title, `/tasks/${item.taskId}`)} — ${formatEasternDate(item.at)}`,
      ),
    },
    {
      header: `📥 **New** — ${digest.ingested.created} ingested · ${digest.ingested.autoDiscarded} auto-discarded`,
      items: [],
    },
    {
      header: `⏳ **Waiting on you** (${digest.waiting.count})`,
      items: digest.waiting.top.map((item) => {
        const due = item.due ? ` · due ${formatEasternDate(item.due)}` : '';
        return `• ${link(item.company, item.title, `/tasks/${item.taskId}`)} — ${TASK_PRIORITY_LABELS[item.priority]}${due}`;
      }),
    },
    {
      header: `⏰ **Deadlines this week** (${digest.deadlines.length})`,
      items: digest.deadlines.map((item) => {
        const target =
          item.kind === 'followup'
            ? `/followups/${item.id}`
            : `/tasks/${item.id}`;
        const marker = item.kind === 'followup' ? '⏱ ' : '';
        return `• ${formatEasternDate(item.due)} — ${marker}${link(item.company, item.title, target)}`;
      }),
    },
    {
      header: `🎯 **In play** (${digest.inPlay.count})`,
      // Grouped by state, in the machine's open-state order; each line
      // carries its group label so capping never orphans a bare heading.
      items: OPEN_FOLLOWUP_STATES.flatMap((state) =>
        (digest.inPlay.byState[state] ?? []).map(
          (item) =>
            `• ${FOLLOWUP_STATE_LABELS[state]}: ${markdownLink(escapeLabel(followupLabel(item)), `/followups/${item.followupId}`, base)}`,
        ),
      ),
    },
    {
      header: `🕸 **Going stale** (${digest.stale.count})`,
      items: digest.stale.oldest.map(
        (item) =>
          `• ${link(item.company, item.title, `/tasks/${item.taskId}`)} — untouched ${item.days} days`,
      ),
    },
  ];
}

/**
 * ONE markdown message for the digest channel. Compact emoji-headed
 * sections, each itemizing at most a handful of lines; when even that
 * overflows the cap, whole sections shrink together (… and N more) until
 * the message fits — headers and counts always survive. Kept alongside the
 * embed renderer as the plain-text fallback.
 */
export function renderDigestDiscord(
  digest: WeeklyDigest,
  dashboardBaseUrl?: string,
): string {
  const sections = buildDiscordSections(
    digest,
    dashboardBaseUrl?.replace(/\/+$/, ''),
  );

  const render = (limit: number): string =>
    [
      `**Sower weekly** — ${formatEasternDate(digest.now)}`,
      ...sections.flatMap((section) => renderSection(section, limit)),
    ].join('\n');

  for (let limit = MAX_SECTION_ITEMS; limit >= 0; limit -= 1) {
    const text = render(limit);
    if (text.length <= DISCORD_DIGEST_MAX_CHARS) {
      return text;
    }
  }
  // Unreachable in practice (limit 0 is a handful of header lines) — belt.
  return `${render(0).slice(0, DISCORD_DIGEST_MAX_CHARS - 1)}…`;
}

/** Discord embed hard caps: field values 1024; ~6000 across the embed. */
const EMBED_FIELD_VALUE_MAX = 1024;
/** Headroom under Discord's 6000-char embed total so we can never 400. */
const EMBED_TOTAL_MAX = 5800;
/** Neutral blurple accent for the weekly digest embed. */
const DIGEST_EMBED_COLOR = 0x5865f2;

/**
 * One section as an embed field value: at most `limit` item lines plus
 * "… and N more", shrunk further (never truncated mid-line) until it fits
 * the 1024-char field cap. Empty sections render an em dash — Discord
 * rejects empty field values.
 */
function embedFieldValue(section: DiscordSection, limit: number): string {
  const shown = section.items.slice(0, limit);
  let rest = section.items.length - shown.length;
  const render = (): string => {
    const lines = [...shown, ...(rest > 0 ? [`… and ${rest} more`] : [])];
    return lines.length === 0 ? '—' : lines.join('\n');
  };
  let value = render();
  while (value.length > EMBED_FIELD_VALUE_MAX && shown.length > 0) {
    shown.pop();
    rest += 1;
    value = render();
  }
  // Pathological single line ("… and N more" always fits): hard-truncate.
  return value.length > EMBED_FIELD_VALUE_MAX
    ? `${value.slice(0, EMBED_FIELD_VALUE_MAX - 1)}…`
    : value;
}

/**
 * The digest as ONE rich embed: a field per section (values reuse the exact
 * per-section markdown lines — embeds still render markdown), each value
 * under the 1024-char field cap, the whole embed under the 6000-char total
 * (whole sections shrink together until it fits, headers and counts always
 * survive). Field names render no markdown, so the bold markers are
 * stripped there.
 */
export function renderDigestDiscordEmbed(
  digest: WeeklyDigest,
  dashboardBaseUrl?: string,
): DiscordEmbed {
  const sections = buildDiscordSections(
    digest,
    dashboardBaseUrl?.replace(/\/+$/, ''),
  );
  const title = `Sower weekly — ${formatEasternDate(digest.now)}`;

  const build = (limit: number): DiscordEmbed => ({
    title,
    color: DIGEST_EMBED_COLOR,
    timestamp: digest.now.toISOString(),
    fields: sections.map((section) => ({
      name: section.header.replace(/\*\*/g, ''),
      value: embedFieldValue(section, limit),
    })),
  });

  const size = (embed: DiscordEmbed): number =>
    (embed.title?.length ?? 0) +
    (embed.fields ?? []).reduce(
      (sum, field) => sum + field.name.length + field.value.length,
      0,
    );

  for (let limit = MAX_SECTION_ITEMS; limit >= 0; limit -= 1) {
    const embed = build(limit);
    if (size(embed) <= EMBED_TOTAL_MAX) {
      return embed;
    }
  }
  // Unreachable in practice (limit 0 is six short headers + dashes) — belt.
  return build(0);
}

/** Escape every HTML-special character — scraped titles are untrusted. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** `4 deadlines` / `1 deadline` — the subject's count phrases. */
function counted(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

// Inline styles only: mail clients strip <style> blocks, so every element
// carries its own. No external assets anywhere.
const STYLE = {
  body: 'margin:0;padding:24px;background-color:#f6f7f9;font-family:-apple-system,"Segoe UI",Helvetica,Arial,sans-serif;color:#1f2328;',
  card: 'max-width:640px;margin:0 auto;background-color:#ffffff;border:1px solid #d0d7de;border-radius:8px;padding:24px;',
  h1: 'margin:0 0 4px 0;font-size:20px;',
  meta: 'margin:0 0 16px 0;color:#57606a;font-size:13px;',
  h2: 'margin:20px 0 8px 0;font-size:15px;border-bottom:1px solid #d8dee4;padding-bottom:4px;',
  list: 'margin:0;padding-left:18px;font-size:14px;line-height:1.6;',
  empty: 'margin:0;color:#57606a;font-size:13px;',
  muted: 'color:#57606a;',
  link: 'color:#0969da;text-decoration:none;',
} as const;

interface EmailLine {
  /** Visible text (UNESCAPED — each renderer escapes for its medium). */
  text: string;
  /** Optional detail rendered muted after the text. */
  detail?: string;
  /** Absolute dashboard link, when the line points at something. */
  href?: string;
}

interface EmailSection {
  title: string;
  lines: EmailLine[];
  /**
   * Shown when `lines` is empty. Omitted for sections whose counts live in
   * the title (📥 New) — the bare heading already says everything.
   */
  emptyText?: string;
}

function sectionHtml(section: EmailSection): string {
  const heading = `<h2 style="${STYLE.h2}">${escapeHtml(section.title)}</h2>`;
  if (section.lines.length === 0) {
    if (!section.emptyText) {
      return heading;
    }
    return `${heading}\n<p style="${STYLE.empty}">${escapeHtml(section.emptyText)}</p>`;
  }
  const items = section.lines
    .map((line) => {
      const text = line.href
        ? `<a href="${escapeHtml(line.href)}" style="${STYLE.link}">${escapeHtml(line.text)}</a>`
        : escapeHtml(line.text);
      const detail = line.detail
        ? ` <span style="${STYLE.muted}">— ${escapeHtml(line.detail)}</span>`
        : '';
      return `<li>${text}${detail}</li>`;
    })
    .join('\n');
  return `${heading}\n<ul style="${STYLE.list}">\n${items}\n</ul>`;
}

function sectionText(section: EmailSection): string {
  const lines =
    section.lines.length === 0
      ? section.emptyText
        ? [`  ${section.emptyText}`]
        : []
      : section.lines.map((line) => {
          const detail = line.detail ? ` — ${line.detail}` : '';
          const href = line.href ? ` <${line.href}>` : '';
          return `  - ${line.text}${detail}${href}`;
        });
  return [section.title, ...lines].join('\n');
}

/**
 * The email: `Sower weekly — 4 sent, 3 deadlines, 2 in play (Jul 22)` as
 * the subject, one self-contained inline-styled HTML document, and a
 * plain-text mirror of the same sections. All dashboard links are absolute
 * to the public dashboard.
 */
export function renderDigestEmail(digest: WeeklyDigest): {
  subject: string;
  html: string;
  text: string;
} {
  const date = formatEasternDate(digest.now);
  const subject = `Sower weekly — ${digest.submitted.count} sent, ${counted(digest.deadlines.length, 'deadline')}, ${digest.inPlay.count} in play (${date})`;

  const taskUrl = (id: string): string =>
    `${EMAIL_DASHBOARD_BASE_URL}/tasks/${id}`;
  const followupUrl = (id: string): string =>
    `${EMAIL_DASHBOARD_BASE_URL}/followups/${id}`;

  const sections: EmailSection[] = [
    {
      title: `📤 Submitted (${digest.submitted.count})`,
      emptyText: 'Nothing sent this week.',
      lines: digest.submitted.items.map((item) => ({
        text: companyTitleLabel(item.company, item.title),
        detail: formatEasternDate(item.at),
        href: taskUrl(item.taskId),
      })),
    },
    {
      // The counts ARE the section — no item lines, no empty text.
      title: `📥 New — ${digest.ingested.created} ingested, ${digest.ingested.autoDiscarded} auto-discarded`,
      lines: [],
    },
    {
      title: `⏳ Waiting on you (${digest.waiting.count})`,
      emptyText: 'Nothing is waiting on you.',
      lines: digest.waiting.top.map((item) => ({
        text: companyTitleLabel(item.company, item.title),
        detail: `${TASK_PRIORITY_LABELS[item.priority]}${item.due ? ` · due ${formatEasternDate(item.due)}` : ''}`,
        href: taskUrl(item.taskId),
      })),
    },
    {
      title: `⏰ Deadlines this week (${digest.deadlines.length})`,
      emptyText: 'No deadlines in the next 7 days.',
      lines: digest.deadlines.map((item) => ({
        text: companyTitleLabel(item.company, item.title),
        detail: `${formatEasternDate(item.due)}${item.kind === 'followup' ? ' · follow-up' : ''}`,
        href:
          item.kind === 'followup' ? followupUrl(item.id) : taskUrl(item.id),
      })),
    },
    {
      title: `🎯 In play (${digest.inPlay.count})`,
      emptyText: 'No open follow-ups.',
      lines: OPEN_FOLLOWUP_STATES.flatMap((state) =>
        (digest.inPlay.byState[state] ?? []).map((item) => ({
          text: followupLabel(item),
          detail: FOLLOWUP_STATE_LABELS[state],
          href: followupUrl(item.followupId),
        })),
      ),
    },
    {
      title: `🕸 Going stale (${digest.stale.count})`,
      emptyText: 'Nothing is going stale.',
      lines: digest.stale.oldest.map((item) => ({
        text: companyTitleLabel(item.company, item.title),
        detail: `untouched ${item.days} days`,
        href: taskUrl(item.taskId),
      })),
    },
  ];

  const html = [
    '<!doctype html>',
    '<html>',
    `<body style="${STYLE.body}">`,
    `<div style="${STYLE.card}">`,
    `<h1 style="${STYLE.h1}">Sower weekly</h1>`,
    `<p style="${STYLE.meta}">Job-application pipeline digest · ${escapeHtml(date)}</p>`,
    ...sections.map(sectionHtml),
    '</div>',
    '</body>',
    '</html>',
  ].join('\n');

  const text = [`Sower weekly — ${date}`, ...sections.map(sectionText)].join(
    '\n\n',
  );

  return { subject, html, text };
}
