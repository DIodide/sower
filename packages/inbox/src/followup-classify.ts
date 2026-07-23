import { FOLLOWUP_KIND_LABELS, type FollowupKind } from '@sower/core';

/**
 * Pure classification of a recruiting email into a follow-up. No I/O: the
 * poll feeds decoded subject/from/body in; tests exercise real-world-shaped
 * fixtures directly. CONSERVATIVE by design — only extracted fields
 * (kind/title/url/dueDate) ever leave this module; raw email text is
 * untrusted input, never a stored output.
 */

export interface FollowupMailInput {
  subject: string;
  from: string;
  bodyText: string;
  /** When the mail arrived — the anchor for relative due dates. */
  receivedAt: Date;
}

export interface FollowupClassification {
  kind: FollowupKind;
  /** `<Kind label> — <cleaned subject>` (Re:/Fwd: stripped). */
  title: string;
  /** Https link on an allowlisted host only — anything else is dropped. */
  url?: string;
  /** Date-only `YYYY-MM-DD` (ET-midnight semantics downstream). */
  dueDate?: string;
}

/** Coding-assessment platforms: a link here marks (and becomes) the url. */
export const ASSESSMENT_LINK_HOSTS: readonly string[] = [
  'hackerrank.com',
  'hackerrankforwork.com',
  'codility.com',
  'codesignal.com',
  'testdome.com',
];

/** Interview scheduling services whose links are kept as the url. */
export const SCHEDULING_LINK_HOSTS: readonly string[] = [
  'calendly.com',
  'goodtime.io',
];

/** Job-board / social senders whose mail is noise, not a follow-up. */
const NOISE_FROM_DOMAINS: readonly string[] = [
  'linkedin.com',
  'indeed.com',
  'glassdoor.com',
];

/** Digest/newsletter subjects are noise regardless of sender. */
const NOISE_SUBJECT_RE =
  /newsletter|digest|job alert|jobs? (?:for you|you may|picked for)|weekly (?:update|roundup)/i;

/**
 * Transactional/ops mail that is NEVER a follow-up, whatever else the body
 * says (live false positives from the first prod sweep): OTP/verification
 * codes (the OTP reader's domain, not ours), application-received
 * confirmations, and billing/quota alerts (a GCP "90% of budget reached"
 * mail from google.com classified as a REJECTION on the Google
 * application). Checked on the subject only — bodies quote too much.
 */
const NOISE_TRANSACTIONAL_SUBJECT_RE =
  /security code|verification code|one.?time (?:code|passcode)|verify your|thank(?:s| you) for (?:applying|your (?:application|interest))|application (?:has been )?received|we(?:'ve| have) received your application|budget|billing|invoice|payment/i;

const REJECTION_RE =
  /\bunfortunately\b|not (?:be )?moving forward|not to move forward|other candidates|will not be (?:progressing|proceeding)/i;

const OFFER_RE =
  /\boffer letter\b|\boffer of employment\b|pleased to (?:offer|extend)|excited to (?:offer|extend)|extend (?:you )?an offer|\bverbal offer\b/i;

const ASSESSMENT_RE = /coding challenge|online assessment|take[\s-]?home/i;

const INTERVIEW_RE =
  /\binterview\b|phone screen|schedule (?:a |your |some )?(?:call|chat|time|conversation)/i;

/** Words that make a mail plausibly recruiting-related (the fallback). */
const RECRUITING_RE =
  /\b(?:application|applied|applying|candidate|candidacy|recruit(?:er|ing|ment)|hiring|position|role|talent|opportunity)\b/i;

/** URL grab, hrefs and bare text alike (mirrors extract.ts). */
const URL_RE = /https?:\/\/[^\s"'<>)\]]+/gi;

/** True when `hostname` is `host` or a subdomain of it. */
function hostMatches(hostname: string, host: string): boolean {
  return hostname === host || hostname.endsWith(`.${host}`);
}

/** First https link on one of `hosts` anywhere in the text, else null. */
function firstLinkOn(hosts: readonly string[], text: string): string | null {
  for (const match of text.matchAll(URL_RE)) {
    // HTML entity-encoded ampersands appear inside href attributes.
    const candidate = match[0].replace(/&amp;/gi, '&');
    let url: URL;
    try {
      url = new URL(candidate);
    } catch {
      continue;
    }
    if (url.protocol !== 'https:') {
      continue;
    }
    const hostname = url.hostname.toLowerCase();
    if (hosts.some((host) => hostMatches(hostname, host))) {
      return url.toString();
    }
  }
  return null;
}

/** The sender's domain from a `Name <user@host>` / bare-address From. */
function fromDomain(from: string): string {
  const match = /@([a-z0-9.-]+)/i.exec(from);
  return (match?.[1] ?? '').toLowerCase().replace(/\.+$/, '');
}

// en-CA renders YYYY-MM-DD (the same ET-calendar-date form the api uses).
const EASTERN_DATE_ISO = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const MONTHS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

const MONTH_NAME_RE =
  'january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec';

/** "within 7 days" / "in the next 3 days" — relative to receivedAt. */
const RELATIVE_DUE_RE =
  /\b(?:within|in)\s+(?:the\s+next\s+)?(\d{1,3})\s+days?\b/i;

/** "by August 4" / "by Aug 4th, 2026" — a named month + day (+ year). */
const BY_MONTH_DAY_RE = new RegExp(
  `\\bby\\s+(?:end of day\\s+|eod\\s+)?(${MONTH_NAME_RE})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`,
  'i',
);

/** "by 08/04" / "by 8/4/2026" — US month-first numeric form. */
const BY_NUMERIC_RE = /\bby\s+(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/;

/** "september"/"Sept."/"jul" → month number, or undefined when unknown. */
function monthNumber(name: string): number | undefined {
  const key = name.toLowerCase().startsWith('sept')
    ? 'sep'
    : name.toLowerCase().slice(0, 3);
  return MONTHS[key];
}

/** Validated `YYYY-MM-DD`, or null for impossible calendar dates. */
function toIsoDate(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return date.toISOString().slice(0, 10);
}

/** `2026-07-18` + 7 → `2026-07-25` (UTC arithmetic — immune to DST). */
function addDaysToIsoDate(isoDate: string, days: number): string {
  const [year, month, day] = isoDate.split('-').map(Number);
  return new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, (day ?? 1) + days))
    .toISOString()
    .slice(0, 10);
}

/**
 * Extract an explicit due date as a `YYYY-MM-DD` string:
 * - "within N days" / "in the next N days" → the received ET date + N;
 * - "by <Month> <day>" / "by MM/DD" → that date, with a missing year
 *   resolved forward (never into the past) from the received date.
 * Anything else → undefined; parsed, never inferred.
 */
export function extractFollowupDueDate(
  text: string,
  receivedAt: Date,
): string | undefined {
  const receivedDate = EASTERN_DATE_ISO.format(receivedAt);
  const receivedYear = Number(receivedDate.slice(0, 4));

  const relative = RELATIVE_DUE_RE.exec(text);
  if (relative?.[1] !== undefined) {
    return addDaysToIsoDate(receivedDate, Number(relative[1]));
  }

  const resolveYear = (
    month: number,
    day: number,
    year?: number,
  ): string | undefined => {
    if (year !== undefined) {
      return toIsoDate(year, month, day) ?? undefined;
    }
    const sameYear = toIsoDate(receivedYear, month, day);
    if (sameYear === null) {
      return undefined;
    }
    // A yearless date earlier than the received date means NEXT year
    // ("by January 5" in December). YYYY-MM-DD compares lexicographically.
    return sameYear >= receivedDate
      ? sameYear
      : (toIsoDate(receivedYear + 1, month, day) ?? undefined);
  };

  const named = BY_MONTH_DAY_RE.exec(text);
  if (named?.[1] !== undefined && named[2] !== undefined) {
    const month = monthNumber(named[1]);
    if (month !== undefined) {
      return resolveYear(
        month,
        Number(named[2]),
        named[3] !== undefined ? Number(named[3]) : undefined,
      );
    }
  }

  const numeric = BY_NUMERIC_RE.exec(text);
  if (numeric?.[1] !== undefined && numeric[2] !== undefined) {
    const rawYear = numeric[3];
    // Two-digit years are ambiguous — treat as yearless (resolved forward).
    const year =
      rawYear !== undefined && rawYear.length === 4
        ? Number(rawYear)
        : undefined;
    return resolveYear(Number(numeric[1]), Number(numeric[2]), year);
  }

  return undefined;
}

/** Strip Re:/Fwd:/Fw: prefixes (repeatedly) and collapse whitespace. */
function cleanSubject(subject: string): string {
  return subject
    .replace(/^(?:\s*(?:re|fwd?|fw)\s*:\s*)+/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** `<Kind label> — <cleaned subject>`, capped at the api's 300-char title. */
function buildTitle(kind: FollowupKind, subject: string): string {
  const cleaned = cleanSubject(subject);
  const label = FOLLOWUP_KIND_LABELS[kind];
  return (cleaned === '' ? label : `${label} — ${cleaned}`).slice(0, 300);
}

/**
 * Classify one email into a follow-up, or null for noise. Priority order:
 * noise first, then terminal outcomes (rejection/offer — their wording can
 * mention interviews/assessments they conclude), then assessment (a
 * platform link is the strongest invite signal), then interview, then a
 * plausible-recruiting fallback of 'recruiter'.
 */
export function classifyFollowupMail(
  input: FollowupMailInput,
): FollowupClassification | null {
  const domain = fromDomain(input.from);
  if (NOISE_FROM_DOMAINS.some((host) => hostMatches(domain, host))) {
    return null;
  }
  if (NOISE_SUBJECT_RE.test(input.subject)) {
    return null;
  }
  if (NOISE_TRANSACTIONAL_SUBJECT_RE.test(input.subject)) {
    return null;
  }

  const text = `${input.subject}\n${input.bodyText}`;
  const dueDate = extractFollowupDueDate(text, input.receivedAt);
  const build = (
    kind: FollowupKind,
    url?: string | null,
  ): FollowupClassification => ({
    kind,
    title: buildTitle(kind, input.subject),
    ...(url ? { url } : {}),
    ...(dueDate !== undefined ? { dueDate } : {}),
  });

  if (REJECTION_RE.test(text)) {
    return build('rejection');
  }
  if (OFFER_RE.test(text)) {
    return build('offer');
  }
  const assessmentLink = firstLinkOn(ASSESSMENT_LINK_HOSTS, text);
  if (assessmentLink !== null || ASSESSMENT_RE.test(text)) {
    return build('assessment', assessmentLink);
  }
  if (INTERVIEW_RE.test(text)) {
    return build('interview', firstLinkOn(SCHEDULING_LINK_HOSTS, text));
  }
  if (RECRUITING_RE.test(text)) {
    return build('recruiter');
  }
  return null;
}
