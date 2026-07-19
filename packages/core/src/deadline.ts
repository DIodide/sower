/**
 * Application-deadline extraction — CONSERVATIVE by design: a deadline is
 * only ever PARSED from an explicit statement, never inferred. Anything
 * ambiguous (numeric-only dates like 3/4/25, month names without a year)
 * yields null rather than a guess. Past dates are still returned — whether a
 * lapsed deadline matters is the caller's judgement, not the parser's.
 *
 * Shared by the api's processTask (adapter descriptions), the
 * investigation-result endpoint (agent-scraped JD markdown), and
 * @sower/investigate's form discovery, so every source parses identically.
 */

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

/** Full names + common abbreviations ("sept" included; "." tolerated after). */
const MONTH_NAME_RE =
  'january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec';

/**
 * Explicit deadline phrasings. Deliberately narrow: each one names the
 * deadline in words ("apply by", "application deadline", "applications close
 * on", "deadline to apply") — a bare date anywhere in a JD never matches.
 */
const TRIGGER_RE =
  'apply\\s+by|application\\s+deadline|deadline\\s+to\\s+apply|applications?\\s+(?:close|closes|are\\s+due|due)';

/**
 * The date itself: ISO (2026-07-30), "July 30, 2026" / "Jul 30 2026", or
 * "30 July 2026" / "30th of July, 2026". Month-name dates REQUIRE a 4-digit
 * year — "apply by July 30" would force us to invent one. Numeric-only forms
 * (3/4/25, 03/04/2025) are excluded outright: day/month order is ambiguous.
 */
const DATE_RE =
  `(?:` +
  `(?<isoY>\\d{4})-(?<isoM>\\d{1,2})-(?<isoD>\\d{1,2})` +
  `|(?<mdyMonth>${MONTH_NAME_RE})\\.?\\s+(?<mdyDay>\\d{1,2})(?:st|nd|rd|th)?(?:,\\s*|\\s+)(?<mdyYear>\\d{4})` +
  `|(?<dmyDay>\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(?<dmyMonth>${MONTH_NAME_RE})\\.?,?\\s+(?<dmyYear>\\d{4})` +
  `)`;

const DEADLINE_RE = new RegExp(
  `(?:${TRIGGER_RE})(?:\\s+is)?\\s*:?\\s*(?:on\\s+|by\\s+)?${DATE_RE}`,
  'i',
);

/** "september"/"Sept."/"jul" → month number, or undefined when unknown. */
function monthNumber(name: string): number | undefined {
  const key = name.toLowerCase().startsWith('sept')
    ? 'sep'
    : name.toLowerCase().slice(0, 3);
  return MONTHS[key];
}

/**
 * Validate a calendar date and render it as ISO 8601 at UTC MIDNIGHT
 * (`2026-07-30T00:00:00.000Z`). Impossible dates (month 13, Feb 30) return
 * null — Date would silently roll them over, which is a form of inference.
 */
function toUtcMidnightIso(
  year: number,
  month: number,
  day: number,
): string | null {
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
  return date.toISOString();
}

/**
 * Extract an EXPLICIT application deadline from free text (a JD, scraped
 * markdown). Returns the first match as an ISO 8601 UTC-midnight timestamp,
 * or null when no explicit deadline statement is present. Never infers:
 * month-name dates need a year, numeric-only dates never match, and past
 * dates are returned as written.
 */
export function extractDeadline(text: string): string | null {
  const match = DEADLINE_RE.exec(text);
  const groups = match?.groups;
  if (!groups) {
    return null;
  }
  if (groups.isoY && groups.isoM && groups.isoD) {
    return toUtcMidnightIso(
      Number(groups.isoY),
      Number(groups.isoM),
      Number(groups.isoD),
    );
  }
  if (groups.mdyMonth && groups.mdyDay && groups.mdyYear) {
    const month = monthNumber(groups.mdyMonth);
    if (month === undefined) return null;
    return toUtcMidnightIso(
      Number(groups.mdyYear),
      month,
      Number(groups.mdyDay),
    );
  }
  if (groups.dmyDay && groups.dmyMonth && groups.dmyYear) {
    const month = monthNumber(groups.dmyMonth);
    if (month === undefined) return null;
    return toUtcMidnightIso(
      Number(groups.dmyYear),
      month,
      Number(groups.dmyDay),
    );
  }
  return null;
}

/**
 * Normalize an ATS-published deadline VALUE (not free text) to the same
 * ISO 8601 UTC-midnight form extractDeadline emits. Accepts a leading
 * `YYYY-MM-DD` (workday cxs `endDate`, greenhouse `application_deadline`,
 * full ISO timestamps, workday's offset-suffixed `2026-08-01-07:00` — the
 * named calendar date is what the source published, so only the date part
 * is kept). Anything else → null.
 */
export function deadlineFromIsoDate(value: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:$|[T\s]|[+-]\d{2}:\d{2}$)/.exec(
    value.trim(),
  );
  if (!match) {
    return null;
  }
  return toUtcMidnightIso(Number(match[1]), Number(match[2]), Number(match[3]));
}
