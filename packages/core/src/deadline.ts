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
 * Date.UTC(ms) for a VALIDATED calendar date's midnight. Impossible dates
 * (month 13, Feb 30) return null — Date would silently roll them over
 * (modern V8 rolls even strict ISO strings), which is a form of inference.
 */
function validUtcMidnightMs(
  year: number,
  month: number,
  day: number,
): number | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }
  const ms = Date.UTC(year, month - 1, day);
  const date = new Date(ms);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return ms;
}

/**
 * Validate a calendar date and render it as ISO 8601 at UTC MIDNIGHT
 * (`2026-07-30T00:00:00.000Z`).
 */
function toUtcMidnightIso(
  year: number,
  month: number,
  day: number,
): string | null {
  const ms = validUtcMidnightMs(year, month, day);
  return ms === null ? null : new Date(ms).toISOString();
}

const EASTERN_TIME_ZONE = 'America/New_York';

// 'longOffset' renders the zone as its numeric UTC offset ("GMT-04:00" under
// EDT, "GMT-05:00" under EST). Which one applies to a given instant comes
// from the tz database, so DST boundaries — and any future rule change —
// are automatic; no offset is ever hardcoded.
const EASTERN_OFFSET_FORMAT = new Intl.DateTimeFormat('en-US', {
  timeZone: EASTERN_TIME_ZONE,
  timeZoneName: 'longOffset',
});

/** America/New_York's UTC offset (ms, negative) in effect at `instant`. */
function easternOffsetMs(instant: Date): number {
  const zone = EASTERN_OFFSET_FORMAT.formatToParts(instant).find(
    (part) => part.type === 'timeZoneName',
  )?.value;
  const match = /^GMT([+-])(\d{2}):(\d{2})$/.exec(zone ?? '');
  if (!match) {
    // New York is never at GMT exactly — a miss means a broken ICU build.
    throw new Error(`cannot derive ${EASTERN_TIME_ZONE} offset from '${zone}'`);
  }
  const sign = match[1] === '-' ? -1 : 1;
  return sign * (Number(match[2]) * 60 + Number(match[3])) * 60_000;
}

/**
 * Epoch ms of a validated wall-clock time READ AS UTC (the zone-independent
 * base both wall-time interpretations below start from). Out-of-range time
 * components → null, same conservative stance as the calendar-date check.
 */
function wallClockAsUtcMs(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  millisecond: number,
): number | null {
  const midnight = validUtcMidnightMs(year, month, day);
  if (midnight === null || hour > 23 || minute > 59 || second > 59) {
    return null;
  }
  return midnight + ((hour * 60 + minute) * 60 + second) * 1000 + millisecond;
}

/**
 * The UTC instant at which America/New_York's wall clock reads the given
 * time — ET MIDNIGHT of a date when only y/m/d are passed (04:00Z under
 * EDT, 05:00Z under EST). The offset is probed twice: first at the wall
 * time read as UTC, then re-derived at the corrected instant — that settles
 * every date, including the EDT/EST boundary days themselves (New York
 * transitions at 02:00 local, so midnight is never skipped or ambiguous).
 */
function easternWallTimeIso(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
  millisecond = 0,
): string | null {
  const wallAsUtc = wallClockAsUtcMs(
    year,
    month,
    day,
    hour,
    minute,
    second,
    millisecond,
  );
  if (wallAsUtc === null) {
    return null;
  }
  const guess = wallAsUtc - easternOffsetMs(new Date(wallAsUtc));
  return new Date(wallAsUtc - easternOffsetMs(new Date(guess))).toISOString();
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
 * Normalize an ATS-published or user-entered deadline VALUE (not free text)
 * to an ISO 8601 UTC instant. Three input shapes:
 *
 * - DATE-ONLY (`2026-07-20`; incl. workday's offset-suffixed
 *   `2026-08-01-07:00`, where the named calendar date is what the source
 *   published): the value means that calendar day in AMERICA/NEW_YORK, so
 *   it normalizes to ET MIDNIGHT of the date — `04:00Z` under EDT, `05:00Z`
 *   under EST. (UTC midnight would land the previous ET evening, making the
 *   midnight-ET deadline alert fire a day early.)
 * - ZONE-LESS timestamps (`2026-08-01T23:59:00`): read as ET wall-clock
 *   time — the user's frame, never the server's locale.
 * - ZONED timestamps (`2026-08-01T23:59:00-04:00`, `…Z`): an exact
 *   INSTANT, passed through unchanged (rendered in UTC).
 *
 * Impossible calendar dates, out-of-range times, and anything else → null
 * (parsed, never inferred).
 */
export function deadlineFromIsoDate(value: string): string | null {
  const trimmed = value.trim();

  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})(?:[+-]\d{2}:\d{2})?$/.exec(
    trimmed,
  );
  if (dateOnly) {
    return easternWallTimeIso(
      Number(dateOnly[1]),
      Number(dateOnly[2]),
      Number(dateOnly[3]),
    );
  }

  const stamp =
    /^(\d{4})-(\d{2})-(\d{2})[T\s](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|[+-]\d{2}:\d{2})?$/i.exec(
      trimmed,
    );
  if (!stamp) {
    return null;
  }
  const year = Number(stamp[1]);
  const month = Number(stamp[2]);
  const day = Number(stamp[3]);
  const hour = Number(stamp[4]);
  const minute = Number(stamp[5]);
  const second = Number(stamp[6] ?? '0');
  const millisecond = Number((stamp[7] ?? '').slice(0, 3).padEnd(3, '0'));
  const zone = stamp[8];
  if (zone === undefined) {
    return easternWallTimeIso(
      year,
      month,
      day,
      hour,
      minute,
      second,
      millisecond,
    );
  }
  const wallAsUtc = wallClockAsUtcMs(
    year,
    month,
    day,
    hour,
    minute,
    second,
    millisecond,
  );
  if (wallAsUtc === null) {
    return null;
  }
  // Explicit offset: the instant is wall time minus the declared offset.
  const offset = /^([+-])(\d{2}):(\d{2})$/.exec(zone);
  const offsetMs = offset
    ? (offset[1] === '-' ? -1 : 1) *
      (Number(offset[2]) * 60 + Number(offset[3])) *
      60_000
    : 0; // 'Z'
  return new Date(wallAsUtc - offsetMs).toISOString();
}
