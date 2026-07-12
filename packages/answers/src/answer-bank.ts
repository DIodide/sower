import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Question, QuestionOption, ResolvedAnswer } from '@sower/core';
import YAML from 'yaml';
import { z } from 'zod';
import type { Profile } from './profile.js';
import { normalizeLabel } from './resolve.js';

/**
 * The curated answer bank: a small set of canonical entries, each of which
 * dedupes many near-identical question wordings (via `aliases`) to one
 * answering strategy that derives its value from the user's profile.
 *
 * TRUTHFULNESS GUARANTEE: every strategy either copies a fact out of the
 * profile (booleanYesNo/numericRange/dateRange, and literal{source} which
 * uses the profile value at a dot-path verbatim), picks a decline-to-answer
 * option (decline), or emits a value the bank curator committed to
 * (literal{value}/choice — consents and "how did you hear", never personal
 * facts).
 * A missing, null, or TODO-placeholder profile value NEVER resolves: the
 * question falls through to later stages or a human. Range strategies only
 * resolve when exactly ONE option's range contains the profile value —
 * gaps and overlaps resolve nothing rather than guessing.
 */

// ---------------------------------------------------------------------------
// Schema / types
// ---------------------------------------------------------------------------

const AnswerStrategySchema = z.discriminatedUnion('type', [
  /**
   * A string used verbatim: either a fixed `value` chosen by the bank
   * curator (e.g. "I Agree" for consent checkboxes) or the profile fact at
   * the `source` dot-path (e.g. graduation.year, education.0.degree).
   * Exactly one of the two must be set (enforced on the entry schema —
   * discriminatedUnion members cannot carry refinements). For selects the
   * string must exactly match an option label or value (after
   * normalization) or nothing resolves.
   */
  z.object({
    type: z.literal('literal'),
    value: z.string().min(1).optional(),
    source: z.string().min(1).optional(),
  }),
  /**
   * The first `prefer` label that exists among the question's options wins
   * (e.g. "how did you hear about us" -> "Other"/"Job board"). Only
   * meaningful for select/multiselect; resolves nothing for text.
   */
  z.object({
    type: z.literal('choice'),
    prefer: z.array(z.string().min(1)).min(1),
  }),
  /**
   * A strictly-boolean profile fact rendered as 'Yes'/'No'. The option match
   * is exact ('Yes'/'No' only) so a 3-option Yes/No/Maybe select resolves to
   * the exact 'Yes' or 'No' — never 'Maybe'. A non-boolean source value
   * resolves nothing.
   */
  z.object({
    type: z.literal('booleanYesNo'),
    source: z.string().min(1),
    /**
     * Optional compound guard: the entry only resolves when the boolean at
     * `guard.source` equals `guard.equals`; otherwise it goes to a human. Used
     * for compound questions like "authorized to work WITHOUT sponsorship?",
     * which is only truthfully answerable from usWorkAuthorized when
     * requiresSponsorship is false.
     */
    guard: z
      .object({ source: z.string().min(1), equals: z.boolean() })
      .optional(),
  }),
  /**
   * Pick the single option whose numeric range contains the profile number
   * at `source` (GPA/SAT/ACT/graduation-year buckets, which differ per
   * company). When `source` is missing, an optional band [low, high] can
   * still resolve COARSE buckets truthfully: an option is only picked when
   * its range contains the ENTIRE band, so we never claim more precision
   * than the profile holds. The band comes from `bandLowSource` /
   * `bandHighSource` / literal `bandHigh` — and, automatically for sources
   * ending in `.gpa`, from `academics.gpaBandLow` with a high of 4.0 (the
   * field is defined on the standard 4.0 scale).
   */
  z.object({
    type: z.literal('numericRange'),
    source: z.string().min(1),
    bandLowSource: z.string().min(1).optional(),
    bandHighSource: z.string().min(1).optional(),
    bandHigh: z.number().optional(),
  }),
  /**
   * Pick the single option whose month range contains the profile 'YYYY-MM'
   * date at `source` (graduation-date dropdowns, bucketed differently per
   * company: "January 2028 - June 2028", "2028", "2029 or later", ...).
   */
  z.object({ type: z.literal('dateRange'), source: z.string().min(1) }),
  /**
   * EEO/demographic questions (race/gender/veteran/disability/ethnicity):
   * ALWAYS pick the decline-to-answer option — never guess demographics.
   * If the question offers no decline option, nothing resolves.
   */
  z.object({ type: z.literal('decline') }),
]);

const AnswerBankEntrySchema = z
  .object({
    /** Stable id, e.g. 'gpa', 'work_authorized_us', 'eeo_gender'. */
    key: z.string().min(1),
    /**
     * Question labels that map to this entry. Compared after normalizeLabel,
     * so raw wordings with punctuation are fine. May be empty for entries
     * matched purely by compliance question id (the eeo_* entries).
     */
    aliases: z.array(z.string().min(1)).default([]),
    strategy: AnswerStrategySchema,
  })
  .superRefine((entry, ctx) => {
    if (entry.strategy.type !== 'literal') return;
    const hasValue = entry.strategy.value !== undefined;
    const hasSource = entry.strategy.source !== undefined;
    if (hasValue === hasSource) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['strategy'],
        message: "literal strategy requires exactly one of 'value' or 'source'",
      });
    }
  });

export const AnswerBankSchema = z.object({
  version: z.literal(1),
  entries: z.array(AnswerBankEntrySchema),
});

export type AnswerStrategy = z.infer<typeof AnswerStrategySchema>;
export type AnswerBankEntry = z.infer<typeof AnswerBankEntrySchema>;
export type AnswerBank = z.infer<typeof AnswerBankSchema>;

/**
 * The committed, PII-free sample bank at the monorepo root. Resolved from
 * this file's location, not process.cwd() (same pattern as the API's
 * DEFAULT_PROFILE_PATH): pnpm runs apps with their own cwd while config/
 * lives at the repo root.
 */
// Computed from the module's own directory rather than
// `new URL(relative, import.meta.url)`: webpack (used by the Next dashboard,
// which transpiles this package for `normalizeLabel`) intercepts that pattern
// as an asset reference and fails on the non-bundlable YAML. The dashboard
// never reads this path; only the API does, in a plain Node context. Guarded so
// a bundler context that lacks a real import.meta.url can't throw at import.
export const DEFAULT_ANSWER_BANK_PATH = ((): string => {
  try {
    return join(
      dirname(fileURLToPath(import.meta.url)),
      '../../../config/answer-bank.sample.yaml',
    );
  } catch {
    return 'config/answer-bank.sample.yaml';
  }
})();

/**
 * Load an answer bank from a YAML file and validate it against
 * AnswerBankSchema. Throws an Error with a clear message if the file is
 * unreadable, is not valid YAML, or does not conform to the schema.
 */
export function loadAnswerBank(path: string): AnswerBank {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to read answer bank file at "${path}": ${message}`);
  }

  let data: unknown;
  try {
    data = YAML.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Answer bank file at "${path}" is not valid YAML: ${message}`,
    );
  }

  const result = AnswerBankSchema.safeParse(data);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Answer bank file at "${path}" is invalid: ${issues}`);
  }
  return result.data;
}

// ---------------------------------------------------------------------------
// Profile dot-path access
// ---------------------------------------------------------------------------

/**
 * Read a dot-path out of the profile ('authorization.usWorkAuthorized',
 * 'education.0.gpa' — numeric segments index arrays). Returns undefined for
 * any path that does not fully resolve. Only own properties are read, so a
 * bad path can never surface prototype members.
 */
export function getProfilePath(profile: Profile, path: string): unknown {
  let current: unknown = profile;
  for (const segment of path.split('.')) {
    if (segment === '') return undefined;
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(segment)) return undefined;
      current = current[Number(segment)];
    } else if (typeof current === 'object' && current !== null) {
      if (!Object.hasOwn(current, segment)) return undefined;
      current = (current as Record<string, unknown>)[segment];
    } else {
      return undefined;
    }
  }
  return current;
}

/**
 * Placeholder detection: a profile string containing the standalone word
 * TODO/TBD/FIXME is an unfilled slot, not a fact, and must never resolve.
 */
const PLACEHOLDER_RE = /\b(?:todo|tbd|fixme)\b/i;

/** Path value with null/empty/placeholder collapsed to null ("no fact"). */
function factAtPath(profile: Profile, path: string): unknown {
  const value = getProfilePath(profile, path);
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '' || PLACEHOLDER_RE.test(trimmed)) return null;
    return trimmed;
  }
  return value;
}

function numberAtPath(profile: Profile, path: string): number | null {
  const value = factAtPath(profile, path);
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value)) {
    return Number.parseFloat(value);
  }
  return null;
}

function booleanAtPath(profile: Profile, path: string): boolean | null {
  const value = factAtPath(profile, path);
  return typeof value === 'boolean' ? value : null;
}

// ---------------------------------------------------------------------------
// Option matching (same exact-match semantics as resolve.ts)
// ---------------------------------------------------------------------------

/**
 * An option matches ONLY when its normalized label exactly equals the
 * normalized candidate, or (fallback) its value exactly equals the raw
 * candidate. Zero or multiple matches resolve nothing — a prefix/partial
 * match could be a specific claim the profile never made.
 */
function matchOption(
  raw: string,
  options: QuestionOption[],
): QuestionOption | undefined {
  const target = normalizeLabel(raw);
  if (target !== '') {
    const byLabel = options.filter((o) => normalizeLabel(o.label) === target);
    if (byLabel.length === 1) return byLabel[0];
    if (byLabel.length > 1) return undefined;
  }
  const rawTrimmed = raw.trim();
  if (rawTrimmed === '') return undefined;
  const byValue = options.filter((o) => String(o.value) === rawTrimmed);
  return byValue.length === 1 ? byValue[0] : undefined;
}

/** The submitted value for a picked option (arrays for multiselects). */
function answerValue(
  question: Question,
  option: QuestionOption,
): string | string[] {
  const value = String(option.value);
  return question.type === 'multiselect' ? [value] : value;
}

/**
 * Fit a candidate string to the question: selects/multiselects require an
 * exact option match (label or value); text fields take it verbatim.
 */
function fitCandidate(
  question: Question,
  candidate: string,
): string | string[] | null {
  if (question.type === 'select' || question.type === 'multiselect') {
    const option = matchOption(candidate, question.options ?? []);
    return option === undefined ? null : answerValue(question, option);
  }
  return candidate;
}

// ---------------------------------------------------------------------------
// Numeric range parsing
// ---------------------------------------------------------------------------

interface NumericInterval {
  lo: number;
  hi: number;
  loInc: boolean;
  hiInc: boolean;
}

const NUM = String.raw`\d+(?:\.\d+)?`;
const DASH = '(?:-|–|—|to|through)';
const RE_NUM_BELOW = new RegExp(`^(?:below|under|less than)\\s*(${NUM})$`, 'i');
const RE_NUM_ABOVE = new RegExp(`^(?:over|above|more than)\\s*(${NUM})$`, 'i');
const RE_NUM_LTE = new RegExp(`^(?:<=|≤)\\s*(${NUM})$`);
const RE_NUM_LT = new RegExp(`^<\\s*(${NUM})$`);
const RE_NUM_GTE = new RegExp(`^(?:>=|≥)\\s*(${NUM})$`);
const RE_NUM_GT = new RegExp(`^>\\s*(${NUM})$`);
const RE_NUM_RANGE = new RegExp(`^(${NUM})\\s*${DASH}\\s*(${NUM})$`, 'i');
const RE_NUM_PLUS = new RegExp(`^(${NUM})\\s*\\+$`);
const RE_NUM_OR_MORE = new RegExp(
  `^(${NUM})\\s+or\\s+(?:more|higher|greater|above|older|later)$`,
  'i',
);
const RE_NUM_OR_LESS = new RegExp(
  `^(${NUM})\\s+or\\s+(?:less|lower|fewer|below|younger|earlier)$`,
  'i',
);
const RE_NUM_BEFORE = new RegExp(`^before\\s+(${NUM})$`, 'i');
const RE_NUM_AFTER = new RegExp(`^after\\s+(${NUM})$`, 'i');
const RE_NUM_EXACT = new RegExp(`^(${NUM})$`);

/** Collapse non-breaking spaces and whitespace runs before parsing. */
function cleanLabel(label: string): string {
  return label
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function group(m: RegExpMatchArray, i: number): number {
  return Number.parseFloat(m[i] ?? 'NaN');
}

/**
 * Parse an option label into a numeric interval, or null for labels that
 * carry no range ("NA", "I don't have SAT score" — such options are
 * skipped, never picked). Handles the bucket formats seen on live forms:
 * "Below 3.2" (x < 3.2), "3.41 - 3.5" (inclusive), "3.6-4.0", "Over 3.9"
 * (x > 3.9), "<1200", ">= 3.5", "1401 - 1500", "36", "17 or younger",
 * "60 or older", "2029 or later", "Before 2021", "1500+".
 */
export function parseNumericInterval(label: string): NumericInterval | null {
  const text = cleanLabel(label);
  let m: RegExpMatchArray | null;

  m = text.match(RE_NUM_BELOW);
  if (m) return { lo: -Infinity, hi: group(m, 1), loInc: false, hiInc: false };
  m = text.match(RE_NUM_ABOVE);
  if (m) return { lo: group(m, 1), hi: Infinity, loInc: false, hiInc: false };
  m = text.match(RE_NUM_LTE);
  if (m) return { lo: -Infinity, hi: group(m, 1), loInc: false, hiInc: true };
  m = text.match(RE_NUM_LT);
  if (m) return { lo: -Infinity, hi: group(m, 1), loInc: false, hiInc: false };
  m = text.match(RE_NUM_GTE);
  if (m) return { lo: group(m, 1), hi: Infinity, loInc: true, hiInc: false };
  m = text.match(RE_NUM_GT);
  if (m) return { lo: group(m, 1), hi: Infinity, loInc: false, hiInc: false };
  m = text.match(RE_NUM_RANGE);
  if (m) return { lo: group(m, 1), hi: group(m, 2), loInc: true, hiInc: true };
  m = text.match(RE_NUM_PLUS);
  if (m) return { lo: group(m, 1), hi: Infinity, loInc: true, hiInc: false };
  m = text.match(RE_NUM_OR_MORE);
  if (m) return { lo: group(m, 1), hi: Infinity, loInc: true, hiInc: false };
  m = text.match(RE_NUM_OR_LESS);
  if (m) return { lo: -Infinity, hi: group(m, 1), loInc: false, hiInc: true };
  m = text.match(RE_NUM_BEFORE);
  if (m) return { lo: -Infinity, hi: group(m, 1), loInc: false, hiInc: false };
  m = text.match(RE_NUM_AFTER);
  if (m) return { lo: group(m, 1), hi: Infinity, loInc: false, hiInc: false };
  m = text.match(RE_NUM_EXACT);
  if (m) return { lo: group(m, 1), hi: group(m, 1), loInc: true, hiInc: true };
  return null;
}

function intervalContains(iv: NumericInterval, x: number): boolean {
  const aboveLo = x > iv.lo || (iv.loInc && x === iv.lo);
  const belowHi = x < iv.hi || (iv.hiInc && x === iv.hi);
  return aboveLo && belowHi;
}

// ---------------------------------------------------------------------------
// Date (month) range parsing
// ---------------------------------------------------------------------------

/** Months are compared as a flat index: year*12 + (month-1). */
interface MonthInterval {
  lo: number;
  hi: number;
}

const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];

/** 1-12 for a month name or unambiguous >=3-letter prefix, else null. */
function monthNumber(token: string): number | null {
  const t = token.toLowerCase().replace(/\.$/, '');
  if (t.length < 3) return null;
  const hits = MONTHS.filter((name) => name.startsWith(t));
  const hit = hits.length === 1 ? hits[0] : undefined;
  return hit === undefined ? null : MONTHS.indexOf(hit) + 1;
}

function monthIndex(year: number, month: number): number {
  return year * 12 + (month - 1);
}

const MON = String.raw`([A-Za-z]{3,9})\.?`;
const RE_DATE_RANGE = new RegExp(
  `^${MON}\\s+(\\d{4})\\s*${DASH}\\s*${MON}\\s+(\\d{4})$`,
  'i',
);
const RE_DATE_SINGLE = new RegExp(`^${MON}\\s+(\\d{4})$`, 'i');
const RE_YEAR_RANGE = new RegExp(`^(\\d{4})\\s*${DASH}\\s*(\\d{4})$`, 'i');
const RE_YEAR = /^(\d{4})$/;
const RE_YEAR_OR_LATER = /^(\d{4})\s+or\s+(?:later|after)$/i;
const RE_YEAR_OR_EARLIER = /^(\d{4})\s+or\s+(?:earlier|before|sooner)$/i;
const RE_YEAR_BEFORE = /^before\s+(\d{4})$/i;
const RE_YEAR_AFTER = /^after\s+(\d{4})$/i;

/**
 * Parse an option label into an inclusive month interval, or null for
 * labels that carry no date range ("I've already graduated" — skipped,
 * never picked). Handles the formats seen on live forms:
 * "January 2028 - June 2028", "December 2027", "2028" (whole year),
 * "2029 or later", "Before 2021", "2026 - 2027".
 */
export function parseMonthInterval(label: string): MonthInterval | null {
  const text = cleanLabel(label);
  let m: RegExpMatchArray | null;

  m = text.match(RE_DATE_RANGE);
  if (m) {
    const m1 = monthNumber(m[1] ?? '');
    const m2 = monthNumber(m[3] ?? '');
    if (m1 === null || m2 === null) return null;
    return {
      lo: monthIndex(Number(m[2]), m1),
      hi: monthIndex(Number(m[4]), m2),
    };
  }
  m = text.match(RE_DATE_SINGLE);
  if (m) {
    const mon = monthNumber(m[1] ?? '');
    if (mon === null) return null;
    const idx = monthIndex(Number(m[2]), mon);
    return { lo: idx, hi: idx };
  }
  m = text.match(RE_YEAR_OR_LATER);
  if (m) return { lo: monthIndex(Number(m[1]), 1), hi: Infinity };
  m = text.match(RE_YEAR_OR_EARLIER);
  if (m) return { lo: -Infinity, hi: monthIndex(Number(m[1]), 12) };
  m = text.match(RE_YEAR_BEFORE);
  if (m) return { lo: -Infinity, hi: monthIndex(Number(m[1]) - 1, 12) };
  m = text.match(RE_YEAR_AFTER);
  if (m) return { lo: monthIndex(Number(m[1]) + 1, 1), hi: Infinity };
  m = text.match(RE_YEAR_RANGE);
  if (m) {
    return {
      lo: monthIndex(Number(m[1]), 1),
      hi: monthIndex(Number(m[2]), 12),
    };
  }
  m = text.match(RE_YEAR);
  if (m) {
    return {
      lo: monthIndex(Number(m[1]), 1),
      hi: monthIndex(Number(m[1]), 12),
    };
  }
  return null;
}

/** Profile date 'YYYY-MM' (an optional -DD suffix is ignored) -> index. */
function monthIndexFromValue(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const m = value.trim().match(/^(\d{4})-(\d{1,2})(?:-\d{1,2})?$/);
  if (!m) return null;
  const month = Number(m[2]);
  if (month < 1 || month > 12) return null;
  return monthIndex(Number(m[1]), month);
}

// ---------------------------------------------------------------------------
// Strategy application
// ---------------------------------------------------------------------------

/**
 * The exact option whose interval covers the whole band [lo, hi] (a point
 * when lo === hi). Options with unparseable labels are skipped. Zero or
 * multiple covering options resolve nothing: a value in a bucket gap or an
 * overlap would be a guess.
 */
function pickNumericOption(
  options: QuestionOption[],
  lo: number,
  hi: number,
): QuestionOption | null {
  const matches = options.filter((o) => {
    const iv = parseNumericInterval(o.label);
    return iv !== null && intervalContains(iv, lo) && intervalContains(iv, hi);
  });
  const only = matches.length === 1 ? matches[0] : undefined;
  return only ?? null;
}

function pickDateOption(
  options: QuestionOption[],
  idx: number,
): QuestionOption | null {
  const matches = options.filter((o) => {
    const iv = parseMonthInterval(o.label);
    return iv !== null && idx >= iv.lo && idx <= iv.hi;
  });
  const only = matches.length === 1 ? matches[0] : undefined;
  return only ?? null;
}

/**
 * Decline-to-answer intent, tested against normalized option labels:
 * "Decline To Self Identify", "I don't wish to answer", "I do not want to
 * answer", "Prefer not to say/state", "I elect not to self-identify".
 * Deliberately does NOT match "I prefer to self-describe" — that is an
 * affirmative demographic claim, not a decline.
 */
const DECLINE_RE =
  /\b(?:decline|prefer not|don t wish|do not wish|do not want|elect not|rather not|choose not to disclose|not to disclose|do not wish to disclose)\b/;

/**
 * The numeric value interval the profile truthfully supports: a point when
 * `source` holds a number, otherwise an optional [low, high] band (explicit
 * band sources/literals, or academics.gpaBandLow with high 4.0 for `.gpa`
 * sources). Null when the profile holds nothing usable.
 */
function numericBand(
  profile: Profile,
  strategy: Extract<AnswerStrategy, { type: 'numericRange' }>,
): { lo: number; hi: number } | null {
  const point = numberAtPath(profile, strategy.source);
  if (point !== null) return { lo: point, hi: point };

  let lo =
    strategy.bandLowSource === undefined
      ? null
      : numberAtPath(profile, strategy.bandLowSource);
  let hi =
    strategy.bandHighSource === undefined
      ? null
      : numberAtPath(profile, strategy.bandHighSource);
  hi = hi ?? strategy.bandHigh ?? null;

  // GPA sources fall back to the profile's stated band automatically:
  // academics.gpaBandLow = "my GPA is at least this, on the 4.0 scale".
  if (lo === null && strategy.source.split('.').at(-1) === 'gpa') {
    lo = numberAtPath(profile, 'academics.gpaBandLow');
    hi = hi ?? 4.0;
  }

  if (lo === null || hi === null || lo > hi) return null;
  return { lo, hi };
}

function applyStrategy(
  strategy: AnswerStrategy,
  question: Question,
  profile: Profile,
): string | string[] | null {
  const options = question.options ?? [];

  switch (strategy.type) {
    case 'literal': {
      // Exactly one of value/source is set (enforced by the entry schema).
      // A source resolves only to a string or finite-number fact — booleans
      // belong to booleanYesNo, and missing/TODO facts resolve nothing.
      let candidate: string | null = null;
      if (strategy.value !== undefined) {
        candidate = strategy.value;
      } else if (strategy.source !== undefined) {
        const fact = factAtPath(profile, strategy.source);
        if (typeof fact === 'string') {
          candidate = fact;
        } else if (typeof fact === 'number' && Number.isFinite(fact)) {
          candidate = String(fact);
        }
      }
      return candidate === null ? null : fitCandidate(question, candidate);
    }

    case 'choice': {
      if (question.type !== 'select' && question.type !== 'multiselect') {
        return null;
      }
      for (const label of strategy.prefer) {
        const option = matchOption(label, options);
        if (option !== undefined) return answerValue(question, option);
      }
      return null;
    }

    case 'booleanYesNo': {
      // Compound guard: refuse unless the guarded boolean matches (e.g.
      // "authorized WITHOUT sponsorship" only answers from usWorkAuthorized
      // when requiresSponsorship === false).
      if (strategy.guard) {
        const guardValue = booleanAtPath(profile, strategy.guard.source);
        if (guardValue !== strategy.guard.equals) return null;
      }
      const value = booleanAtPath(profile, strategy.source);
      if (value === null) return null;
      return fitCandidate(question, value ? 'Yes' : 'No');
    }

    case 'numericRange': {
      const band = numericBand(profile, strategy);
      if (band === null) return null;
      if (question.type === 'select' || question.type === 'multiselect') {
        const option = pickNumericOption(options, band.lo, band.hi);
        return option === null ? null : answerValue(question, option);
      }
      // Text fields take the exact number verbatim; a band is not an exact
      // number, so it never fills a text field.
      return band.lo === band.hi ? String(band.lo) : null;
    }

    case 'dateRange': {
      const value = factAtPath(profile, strategy.source);
      const idx = monthIndexFromValue(value);
      if (idx === null) return null;
      if (question.type === 'select' || question.type === 'multiselect') {
        const option = pickDateOption(options, idx);
        return option === null ? null : answerValue(question, option);
      }
      return String(value);
    }

    case 'decline': {
      if (question.type !== 'select' && question.type !== 'multiselect') {
        return null;
      }
      const option = options.find((o) =>
        DECLINE_RE.test(normalizeLabel(o.label)),
      );
      return option === undefined ? null : answerValue(question, option);
    }

    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Entry lookup
// ---------------------------------------------------------------------------

/**
 * Greenhouse renders its EEO compliance block with stable question ids but
 * per-tenant labels, so those ids map straight to the bank's eeo_* entries.
 */
const COMPLIANCE_ID_TO_KEY: ReadonlyMap<string, string> = new Map([
  ['gender', 'eeo_gender'],
  ['race', 'eeo_race'],
  ['veteran_status', 'eeo_veteran'],
  ['disability_status', 'eeo_disability'],
  ['ethnicity', 'eeo_ethnicity'],
]);

interface BankIndex {
  byAlias: Map<string, AnswerBankEntry>;
  byKey: Map<string, AnswerBankEntry>;
}

// Index cache keyed on bank object identity: the API loads the bank once at
// startup and reuses it per request, so indexing 100+ entries per question
// would be wasted work. Banks are treated as immutable after load.
const bankIndexCache = new WeakMap<AnswerBank, BankIndex>();

function indexBank(bank: AnswerBank): BankIndex {
  const cached = bankIndexCache.get(bank);
  if (cached !== undefined) return cached;
  const byAlias = new Map<string, AnswerBankEntry>();
  const byKey = new Map<string, AnswerBankEntry>();
  for (const entry of bank.entries) {
    if (!byKey.has(entry.key)) byKey.set(entry.key, entry);
    for (const alias of entry.aliases) {
      const normalized = normalizeLabel(alias);
      // First entry wins on duplicate aliases (mirrors the user-bank rule).
      if (normalized !== '' && !byAlias.has(normalized)) {
        byAlias.set(normalized, entry);
      }
    }
  }
  const index = { byAlias, byKey };
  bankIndexCache.set(bank, index);
  return index;
}

function entryForQuestion(
  question: Question,
  bank: AnswerBank,
): AnswerBankEntry | null {
  const index = indexBank(bank);
  const byAlias = index.byAlias.get(normalizeLabel(question.label));
  if (byAlias !== undefined) return byAlias;
  // Multiselect compliance ids can carry an array suffix ('race[]').
  const complianceKey = COMPLIANCE_ID_TO_KEY.get(
    question.id.replace(/\[\]$/, ''),
  );
  if (complianceKey !== undefined) {
    return index.byKey.get(complianceKey) ?? null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Public resolution entry point
// ---------------------------------------------------------------------------

/**
 * Resolve one question from the curated answer bank, or null when the bank
 * has no truthful answer for it (unknown label, missing/TODO profile value,
 * no matching option, bucket gap/overlap). Pure: no I/O beyond the passed
 * bank and profile. Bank answers derive from the profile, so they carry
 * source 'profile'.
 */
export function resolveFromAnswerBank(
  question: Question,
  profile: Profile,
  bank: AnswerBank,
): ResolvedAnswer | null {
  // File uploads resolve from stored documents, never from the bank.
  if (question.type === 'file') return null;
  const entry = entryForQuestion(question, bank);
  if (entry === null) return null;
  const value = applyStrategy(entry.strategy, question, profile);
  if (value === null) return null;
  return { questionId: question.id, source: 'profile', value };
}
