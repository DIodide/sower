import {
  deadlineFromIsoDate,
  FOLLOWUP_KIND_LABELS,
  type TaskState,
} from '@sower/core';
import {
  applicationTasks,
  events,
  type Followup,
  followups,
  jobs,
} from '@sower/db';
import {
  ASSESSMENT_LINK_HOSTS,
  classifyFollowupMail,
  GmailInboxReader,
  type GmailMessageSummary,
  SCHEDULING_LINK_HOSTS,
} from '@sower/inbox';
import { desc, eq, inArray } from 'drizzle-orm';
import { syncFollowupCalendarEvent } from './calendar-sync.js';
import { escapeLabel } from './discord-ingest.js';
import type { Deps } from './types.js';

/**
 * Follow-up inbox poll: scan recent Gmail for post-application mail (OA
 * invites, interview requests, offers, rejections, recruiter notes), match
 * each message to a SENT application by company name, classify it
 * (@sower/inbox followup-classify — pure), and record matched mail as
 * followups rows. Fully dormant until the Gmail OAuth triple
 * (GMAIL_CLIENT_ID/SECRET/REFRESH_TOKEN) is configured.
 *
 * Email content is UNTRUSTED input: the classifier's extracted fields
 * (kind/title/url/dueDate) are re-validated (url against the same host
 * allowlists), and the message itself is stored ONLY as sanitized plain
 * TEXT in source_body (tags stripped, never HTML) for the dashboard's
 * "Source email" view.
 */

/** Simple-on-purpose: recent primary-inbox mail; matching happens here. */
export const FOLLOWUP_SEARCH_QUERY = 'newer_than:7d in:inbox category:primary';

/** Message ids examined per run (Gmail's newest-first ordering). */
const MAX_MESSAGES_PER_RUN = 100;

/**
 * Sender domains whose mail may match a task by company name in the
 * subject/body alone: assessment/scheduling platforms and ATS mailers send
 * on the company's behalf from their own domains ("Akuna Capital has
 * invited you…" from @hackerrankforwork.com). Any OTHER sender must carry
 * the company token in its own from-domain — without this, any address
 * that merely mentions a company name could attach a forged follow-up to
 * that application.
 */
const TRUSTED_SENDER_HOSTS: readonly string[] = [
  ...ASSESSMENT_LINK_HOSTS,
  ...SCHEDULING_LINK_HOSTS,
  'hackerrankforwork.com',
  'greenhouse.io',
  'greenhouse-mail.io',
  'ashbyhq.com',
  'lever.co',
  'hire.lever.co',
  'myworkday.com',
  'workday.com',
  'icims.com',
  'smartrecruiters.com',
];

function isTrustedSenderDomain(domain: string): boolean {
  return TRUSTED_SENDER_HOSTS.some(
    (host) => domain === host || domain.endsWith(`.${host}`),
  );
}

/** Creation cap per run — a runaway match can never flood the table. */
export const MAX_FOLLOWUP_CREATIONS_PER_RUN = 10;

/** Follow-ups only attach to applications that were actually sent. */
const SENT_STATES: readonly TaskState[] = ['SUBMITTED', 'CONFIRMED'];

/** The Gmail surface the poll needs (GmailInboxReader satisfies it). */
export interface FollowupMailbox {
  searchMessageIds(query: string, maxResults?: number): Promise<string[]>;
  readMessage(id: string): Promise<GmailMessageSummary | null>;
}

export interface FollowupInboxPollResult {
  enabled: boolean;
  /** Message ids the Gmail search returned. */
  scanned: number;
  /** Messages matched to a sent application by company name. */
  matched: number;
  /** Followups rows created (≤ MAX_FOLLOWUP_CREATIONS_PER_RUN). */
  created: number;
  /** Scanned messages that created nothing (dedupe/no-match/noise/cap). */
  skipped: number;
}

/** ` lowercased text with punctuation collapsed to single spaces `. */
function normalizeText(text: string): string {
  return ` ${text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()} `;
}

/**
 * Company-name / job-title tokens usable for matching: lowercased,
 * punctuation stripped, deduped, and ≥4 chars — short tokens ("ai", "the",
 * "inc") match far too much mail to be evidence of anything.
 */
function matchTokens(text: string): string[] {
  return [
    ...new Set(
      text
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((token) => token.length >= 4),
    ),
  ];
}

/** The sender's domain as addressed (dots intact), lowercased. */
function fromDomain(from: string): string {
  const match = /@([a-z0-9.-]+)/i.exec(from);
  return (match?.[1] ?? '').toLowerCase();
}

/** Common second-level TLD labels (akunacapital.co.uk → three labels). */
const SECOND_LEVEL_TLDS = new Set(['co', 'com', 'org', 'net', 'ac', 'gov']);

/**
 * The sender's REGISTRABLE domain, flattened for company-token containment
 * (mail.akunacapital.com → akunacapitalcom). Only the part the sender had
 * to register participates in company matching: anyone can mint
 * `akuna-capital.attacker.io` as a subdomain, so labels left of the
 * registrable boundary must never match a company.
 */
function fromDomainFlat(from: string): string {
  const labels = fromDomain(from).split('.').filter(Boolean);
  if (labels.length === 0) {
    return '';
  }
  const secondToLast = labels[labels.length - 2];
  const keep =
    labels.length >= 3 && secondToLast && SECOND_LEVEL_TLDS.has(secondToLast)
      ? 3
      : 2;
  return labels
    .slice(-keep)
    .join('')
    .replace(/[^a-z0-9]/g, '');
}

interface SentTask {
  taskId: string;
  company: string;
  /** Company tokens — the sender-anchored gate. */
  tokens: string[];
  /** Job-title tokens (same normalization) — the overlap tiebreaker. */
  titleTokens: string[];
  /** Title marks a non-application (event registration, newsletter, …). */
  nonApplication: boolean;
}

/**
 * Titles that mark a task as something other than a real application. Such
 * a task only wins the match on a STRICTLY higher title-overlap score —
 * never on a zero-zero tie, where generic recruiting mail must land on a
 * real application, not the company's freshest event registration.
 */
const NON_APPLICATION_TITLE_RE =
  /\b(?:event|registration|newsletter|kickoff)\b/i;

/**
 * Match one message to a sent application. The sender gate first — two
 * paths, both anchored on the SENDER, never on message content alone:
 *  - the company token appears in the from-domain (the company's own mail),
 *  - or the sender is a trusted assessment/scheduling/ATS domain, in which
 *    case a whole-word company token in the subject/body attaches it.
 * Among the gated company's tasks the message then lands on the highest
 * job-title-token overlap with the subject+body, so "Platform Engineer"
 * mail reaches the Platform Engineer application rather than whichever
 * task was updated last; ties resolve to the most recently updated (the
 * array order), except that a non-application task never wins a tie (see
 * NON_APPLICATION_TITLE_RE). Null when nothing matches — unmatched mail is
 * never stored.
 */
function matchTask(
  tasks: SentTask[],
  message: GmailMessageSummary,
): SentTask | null {
  const domain = fromDomainFlat(message.from);
  if (domain === '') {
    return null;
  }
  // Trust is judged on the dotted domain (exact host or dot-suffix match);
  // the flattened form exists only for company-token containment.
  const trustedSender = isTrustedSenderDomain(fromDomain(message.from));
  const text = normalizeText(`${message.subject}\n${message.bodyText}`);
  let best: SentTask | null = null;
  let bestScore = -1;
  for (const task of tasks) {
    const gated = task.tokens.some(
      (token) =>
        domain.includes(token) ||
        (trustedSender && text.includes(` ${token} `)),
    );
    if (!gated) {
      continue;
    }
    const score = task.titleTokens.filter((token) =>
      text.includes(` ${token} `),
    ).length;
    if (
      best === null ||
      score > bestScore ||
      (score === bestScore && best.nonApplication && !task.nonApplication)
    ) {
      best = task;
      bestScore = score;
    }
  }
  return best;
}

/** source_body cap — mirrors the notes cap; ample for any real email. */
const SOURCE_BODY_MAX_CHARS = 20_000;

/** The named entities that actually occur in recruiting mail markup. */
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  copy: '©',
  reg: '®',
  trade: '™',
};

/**
 * Reduce a Gmail bodyText blob to plain text. collectBodies (@sower/inbox)
 * joins EVERY decoded text/* part — text/html included — so residual
 * markup is expected: drop style/script/comment blocks wholesale, turn
 * breaks and block closers into newlines, strip every remaining tag,
 * decode the common entities, and collapse blank runs. The output is still
 * UNTRUSTED text — safe only because it is stored and rendered as TEXT.
 */
export function emailBodyToPlainText(bodyText: string): string {
  const stripped = bodyText
    .replace(/<(style|script)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|tr|li|h[1-6]|table|ul|ol|blockquote)\s*>/gi, '\n')
    .replace(/<[^>]*>/g, ' ');
  const decoded = stripped.replace(
    /&(#x?[0-9a-f]+|[a-z]+);/gi,
    (whole, entity: string) => {
      if (entity.startsWith('#')) {
        const code =
          entity[1]?.toLowerCase() === 'x'
            ? Number.parseInt(entity.slice(2), 16)
            : Number.parseInt(entity.slice(1), 10);
        return Number.isNaN(code) || code < 0 || code > 0x10ffff
          ? whole
          : String.fromCodePoint(code);
      }
      return NAMED_ENTITIES[entity.toLowerCase()] ?? whole;
    },
  );
  return decoded
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * What a created follow-up stores as its source_body: a small
 * From/Subject/Date header block plus the sanitized plain-text body,
 * capped. Verbatim untrusted TEXT — the dashboard renders it as a string,
 * never as HTML.
 */
export function emailSourceBody(message: GmailMessageSummary): string {
  const header = [
    `From: ${message.from}`,
    `Subject: ${message.subject}`,
    `Date: ${message.receivedAt ? message.receivedAt.toISOString() : 'unknown'}`,
  ].join('\n');
  return `${header}\n\n${emailBodyToPlainText(message.bodyText)}`.slice(
    0,
    SOURCE_BODY_MAX_CHARS,
  );
}

/**
 * Re-validate a classifier url (defense in depth): https and a host on the
 * assessment/scheduling allowlists, else dropped.
 */
export function allowedFollowupUrl(value: string | undefined): string | null {
  if (!value || value.length > 2000) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') {
    return null;
  }
  const hostname = url.hostname.toLowerCase();
  const allowed = [...ASSESSMENT_LINK_HOSTS, ...SCHEDULING_LINK_HOSTS];
  return allowed.some(
    (host) => hostname === host || hostname.endsWith(`.${host}`),
  )
    ? url.toString()
    : null;
}

/** Discord hard-caps messages at 2000 chars. */
const DISCORD_MESSAGE_MAX_CHARS = 2000;

/**
 * Best-effort #alerts note for one ingested follow-up (mirrors how the
 * deadline alerts post). Silently skipped when Discord / the alerts
 * channel is unset; a send failure is logged, never thrown.
 */
async function notifyFollowupIngested(
  deps: Deps,
  followup: Followup,
  company: string,
): Promise<void> {
  const { notify, config } = deps;
  const channelId = config.DISCORD_ALERTS_CHANNEL_ID;
  if (!notify || !config.DISCORD_ENABLED || !channelId) {
    return;
  }
  const parts = [
    `📬 ${FOLLOWUP_KIND_LABELS[followup.kind]} for **${escapeLabel(company)}** — ${escapeLabel(followup.title)}`,
  ];
  if (config.DASHBOARD_BASE_URL) {
    const base = config.DASHBOARD_BASE_URL.replace(/\/+$/, '');
    parts.push(`[open in sower](${base}/followups/${followup.id})`);
  }
  const text = parts.join(' · ');
  try {
    await notify.postChannelMessage(
      channelId,
      text.length > DISCORD_MESSAGE_MAX_CHARS
        ? `${text.slice(0, DISCORD_MESSAGE_MAX_CHARS - 1)}…`
        : text,
    );
  } catch (error) {
    console.warn(
      `[sower] follow-up ingest notify failed for ${followup.id}:`,
      error,
    );
  }
}

/**
 * One poll pass. `mailbox` is a test seam; production builds a
 * GmailInboxReader from the configured OAuth triple.
 */
export async function runFollowupInboxPoll(
  deps: Deps,
  mailbox?: FollowupMailbox,
): Promise<FollowupInboxPollResult> {
  const { db, config } = deps;
  if (
    !config.GMAIL_CLIENT_ID ||
    !config.GMAIL_CLIENT_SECRET ||
    !config.GMAIL_REFRESH_TOKEN
  ) {
    return { enabled: false, scanned: 0, matched: 0, created: 0, skipped: 0 };
  }
  const reader =
    mailbox ??
    new GmailInboxReader({
      clientId: config.GMAIL_CLIENT_ID,
      clientSecret: config.GMAIL_CLIENT_SECRET,
      refreshToken: config.GMAIL_REFRESH_TOKEN,
    });

  // Sent applications with their jobs — the only tasks mail can attach to.
  // Most-recently-updated first so an ambiguous match lands on the
  // freshest application.
  const taskRows = await db
    .select({
      taskId: applicationTasks.id,
      company: jobs.company,
      title: jobs.title,
    })
    .from(applicationTasks)
    .innerJoin(jobs, eq(applicationTasks.jobId, jobs.id))
    .where(inArray(applicationTasks.state, [...SENT_STATES]))
    .orderBy(desc(applicationTasks.updatedAt));
  const tasks: SentTask[] = [];
  for (const row of taskRows) {
    const company = row.company?.trim();
    if (!company) {
      continue;
    }
    const tokens = matchTokens(company);
    if (tokens.length > 0) {
      const title = row.title ?? '';
      tasks.push({
        taskId: row.taskId,
        company,
        tokens,
        titleTokens: matchTokens(title),
        nonApplication: NON_APPLICATION_TITLE_RE.test(title),
      });
    }
  }

  const ids = await reader.searchMessageIds(
    FOLLOWUP_SEARCH_QUERY,
    MAX_MESSAGES_PER_RUN,
  );
  const scanned = ids.length;

  // Dedupe BEFORE reading: message ids already ingested (source_ref) are
  // skipped without a Gmail fetch. The insert below still keys on the
  // partial unique index, so a concurrent poll can't double-create either.
  const known =
    ids.length > 0
      ? await db
          .select({ sourceRef: followups.sourceRef })
          .from(followups)
          .where(inArray(followups.sourceRef, ids))
      : [];
  const knownRefs = new Set(known.map((row) => row.sourceRef));

  let matched = 0;
  let created = 0;
  for (const id of ids) {
    if (created >= MAX_FOLLOWUP_CREATIONS_PER_RUN) {
      break;
    }
    if (knownRefs.has(id)) {
      continue;
    }
    const message = await reader.readMessage(id);
    if (!message) {
      continue;
    }
    const task = matchTask(tasks, message);
    if (!task) {
      continue;
    }
    matched += 1;
    const classified = classifyFollowupMail({
      subject: message.subject,
      from: message.from,
      bodyText: message.bodyText,
      receivedAt: message.receivedAt ?? new Date(),
    });
    if (!classified) {
      continue;
    }
    const dueDate = classified.dueDate
      ? new Date(deadlineFromIsoDate(classified.dueDate) ?? classified.dueDate)
      : null;
    const inserted = await db
      .insert(followups)
      .values({
        taskId: task.taskId,
        kind: classified.kind,
        title: classified.title.slice(0, 300),
        state: 'RECEIVED',
        url: allowedFollowupUrl(classified.url),
        dueDate,
        source: 'email',
        sourceRef: id,
        sourceBody: emailSourceBody(message),
      })
      .onConflictDoNothing()
      .returning();
    const followup = inserted[0];
    if (!followup) {
      // A concurrent poll won the (source_ref) race — nothing to do.
      continue;
    }
    created += 1;
    await db.insert(events).values({
      taskId: task.taskId,
      type: 'FOLLOWUP_CREATED',
      data: {
        followupId: followup.id,
        kind: followup.kind,
        title: followup.title,
        source: 'email',
      },
    });
    if (dueDate) {
      // Best-effort calendar mirror (self-gated, never throws by contract).
      await syncFollowupCalendarEvent(deps, followup.id);
    }
    await notifyFollowupIngested(deps, followup, task.company);
  }
  return {
    enabled: true,
    scanned,
    matched,
    created,
    skipped: scanned - created,
  };
}
