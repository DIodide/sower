import type {
  Question,
  QuestionOption,
  ResolutionResult,
  ResolvedAnswer,
} from '@sower/core';
import type { Profile } from './profile.js';

/**
 * Normalize a question label for matching: lowercase, strip punctuation,
 * collapse whitespace.
 */
export function normalizeLabel(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A previously saved answer, keyed by its normalized question label. */
export interface BankEntry {
  normalizedLabel: string;
  value: string | string[];
}

/** A stored document available for file-type questions. */
export interface DocumentEntry {
  kind: string;
  storagePath: string;
  filename: string;
}

export interface ResolveOptions {
  bank?: BankEntry[];
  documents?: DocumentEntry[];
}

type ProfileValueGetter = (profile: Profile) => string | null;

const cityState: ProfileValueGetter = (p) =>
  `${p.location.city}, ${p.location.state}`;
const country: ProfileValueGetter = (p) => p.location.country;
const school: ProfileValueGetter = (p) => p.education[0]?.school ?? null;
// "Current company" is only truthful for a work entry that has not ended.
const currentCompany: ProfileValueGetter = (p) =>
  p.work.find((w) => w.endDate === undefined)?.company ?? null;

/**
 * The single most recent work entry: a lone current job (no endDate) wins;
 * otherwise the ended job with the latest endDate. Any ambiguity — multiple
 * current jobs, tied end dates, empty history — returns null so the question
 * goes to a human instead of guessing. Date strings are compared
 * lexicographically, which is correct for the ISO-style dates ('YYYY-MM')
 * the profile uses.
 */
function mostRecentWorkEntry(p: Profile): Profile['work'][number] | null {
  const current = p.work.filter((w) => w.endDate === undefined);
  if (current.length === 1) return current[0] ?? null;
  if (current.length > 1) return null;

  let latest: Profile['work'][number] | null = null;
  let tied = false;
  for (const entry of p.work) {
    const end = entry.endDate ?? '';
    const latestEnd = latest?.endDate ?? '';
    if (latest === null || end > latestEnd) {
      latest = entry;
      tied = false;
    } else if (end === latestEnd) {
      tied = true;
    }
  }
  return tied ? null : latest;
}

const mostRecentEmployer: ProfileValueGetter = (p) =>
  mostRecentWorkEntry(p)?.company ?? null;
const mostRecentJobTitle: ProfileValueGetter = (p) =>
  mostRecentWorkEntry(p)?.title ?? null;

/**
 * The education entry with the latest endDate ("most recent school
 * attended" — a school currently attended is still the most recent one).
 * Tied end dates or an empty history return null rather than guessing.
 */
const mostRecentSchool: ProfileValueGetter = (p) => {
  let latest: Profile['education'][number] | null = null;
  let tied = false;
  for (const entry of p.education) {
    if (latest === null || entry.endDate > latest.endDate) {
      latest = entry;
      tied = false;
    } else if (entry.endDate === latest.endDate) {
      tied = true;
    }
  }
  return tied ? null : (latest?.school ?? null);
};

/**
 * Exact normalized-label dictionary. A label resolves only when its
 * normalized form EXACTLY equals one of these keys — never via substring
 * matching, which fabricates answers ("ethnicity" contains "city",
 * "relocation" contains "location", "manager's email" contains "email").
 *
 * Entries below the census marker come from the live Greenhouse field
 * census; each maps to a single unambiguous profile fact. Census candidates
 * that require judgment or have no profile fact were deliberately skipped:
 * "what is the most recent degree you obtained" ("obtained" is untruthful
 * for an in-progress degree), "pronouns" and "name pronunciation" (no
 * profile fact), "what is the zip code of your primary residence" (profile
 * has no zip), "which u s state or canadian province do you reside in"
 * (only truthful for US/Canada residents, which needs a judgment guard).
 */
const LABEL_DICTIONARY: ReadonlyMap<string, ProfileValueGetter> = new Map([
  ['first name', (p: Profile) => p.name.first],
  ['last name', (p: Profile) => p.name.last],
  ['full name', (p: Profile) => `${p.name.first} ${p.name.last}`],
  ['email', (p: Profile) => p.email],
  ['email address', (p: Profile) => p.email],
  ['e mail', (p: Profile) => p.email],
  ['e mail address', (p: Profile) => p.email],
  ['phone', (p: Profile) => p.phone],
  ['phone number', (p: Profile) => p.phone],
  ['linkedin', (p: Profile) => p.links.linkedin ?? null],
  ['linkedin profile', (p: Profile) => p.links.linkedin ?? null],
  ['linkedin url', (p: Profile) => p.links.linkedin ?? null],
  ['github', (p: Profile) => p.links.github ?? null],
  ['github url', (p: Profile) => p.links.github ?? null],
  ['github profile', (p: Profile) => p.links.github ?? null],
  ['website', (p: Profile) => p.links.website ?? null],
  ['portfolio', (p: Profile) => p.links.website ?? null],
  ['location', cityState],
  ['current location', cityState],
  ['current location city', cityState],
  ['location city', cityState],
  ['city', cityState],
  ['school', school],
  ['university', school],
  ['current company', currentCompany],
  // --- Additions from the live Greenhouse field census ---
  ['preferred first name', (p: Profile) => p.name.first],
  ['preferred name', (p: Profile) => p.name.first],
  ['preferred last name', (p: Profile) => p.name.last],
  ['twitter', (p: Profile) => p.links.twitter ?? null],
  ['current employer if applicable', currentCompany],
  ['who is your current or most recent employer', mostRecentEmployer],
  ['who is your current or previous employer', mostRecentEmployer],
  ['what is your current or more recent job title', mostRecentJobTitle],
  ['what is your current or previous job title', mostRecentJobTitle],
  ['what is the most recent school you attended', mostRecentSchool],
  ['what is your current country of residence', country],
  ['please select the country where you currently reside', country],
  ['please choose the country in which you are located', country],
]);

// Word-boundary patterns applied to the normalized label. These are the ONLY
// non-exact label matches, and each resolves strictly to 'Yes'/'No' copied
// from a profile boolean — never to a synthesized specific claim.
const WORK_AUTHORIZATION_RE = /\b(?:authorized to work|work authorization)\b/;
const SPONSORSHIP_RE = /\bsponsorship\b/;
// Negative guard: negated or inverted phrasing ("without sponsorship",
// "not authorized") flips the meaning of a yes/no answer, so such questions
// are never auto-resolved.
const NEGATION_RE = /\b(?:not|without|never)\b/;
// Relocation guard: questions like "able to relocate to Germany after visa
// sponsorship?" mention "sponsorship" but ask about relocation intent, not the
// sponsorship boolean. Any relocation phrasing punts the whole question to a
// human so we never answer the wrong question (verified overtrigger: Scale AI).
const RELOCATION_RE = /\brelocat/;

/**
 * Compute the raw string value for a question from the profile (resolution
 * stages 1-3: standard field ids, exact label dictionary, guarded yes/no
 * regexes), or null if the profile holds no answer for it. This is strictly
 * deterministic lookup — it NEVER synthesizes a value that is not present in
 * the profile, and it never matches labels by substring. When in doubt, it
 * returns null so later stages (bank, profile.custom) or a human can answer.
 */
function computeProfileValue(
  question: Question,
  label: string,
  profile: Profile,
): string | null {
  // 1) Exact match on greenhouse standard field ids.
  switch (question.id) {
    case 'first_name':
      return profile.name.first;
    case 'last_name':
      return profile.name.last;
    case 'email':
      return profile.email;
    case 'phone':
      return profile.phone;
    case 'resume':
    case 'cover_letter':
      // File fields carry no profile text value.
      return null;
    case 'location':
    case 'city':
    case 'candidate_location':
    case 'job_application_location':
      return cityState(profile);
    default:
      break;
  }

  // 2) Exact normalized-label dictionary match.
  const getter = LABEL_DICTIONARY.get(label);
  if (getter !== undefined) return getter(profile);

  // 3) Word-boundary regex matches with negative guards.
  const mentionsAuthorization = WORK_AUTHORIZATION_RE.test(label);
  const mentionsSponsorship = SPONSORSHIP_RE.test(label);
  if (mentionsAuthorization || mentionsSponsorship) {
    // Compound questions (authorization AND sponsorship) cannot be answered
    // with a single yes/no, and negated phrasing inverts the answer — both
    // go to a human.
    if (mentionsAuthorization && mentionsSponsorship) return null;
    if (NEGATION_RE.test(label)) return null;
    // Relocation questions can mention sponsorship but ask something else.
    if (RELOCATION_RE.test(label)) return null;
    if (mentionsAuthorization) {
      return profile.authorization.usWorkAuthorized ? 'Yes' : 'No';
    }
    return profile.authorization.requiresSponsorship ? 'Yes' : 'No';
  }

  return null;
}

/**
 * For select/multiselect questions, an option resolves ONLY when its
 * normalized label EXACTLY equals the normalized computed value — 'yes'/'no'
 * for boolean-derived answers, exact string equality otherwise. Prefix or
 * partial matches never resolve: an option like
 * 'Yes, Netherlands Highly Skilled Migrant Visa' is a specific claim the
 * profile never made. If zero or multiple options match exactly, nothing
 * resolves and the question goes to missing.
 */
function matchOption(
  raw: string,
  options: QuestionOption[],
): QuestionOption | undefined {
  // Label first: profile-derived 'Yes'/'No' and bank entries stored as labels
  // resolve against the option's human label.
  const target = normalizeLabel(raw);
  if (target !== '') {
    const byLabel = options.filter((o) => normalizeLabel(o.label) === target);
    if (byLabel.length === 1) return byLabel[0];
    if (byLabel.length > 1) return undefined; // ambiguous label
  }
  // Fallback: exact option-VALUE match. The dashboard's NEEDS_INPUT form
  // submits (and the answers bank stores) the option's value id, not its
  // label, so a saved select answer must round-trip by value. Exact string
  // equality only — never a synthesized or partial claim.
  const rawTrimmed = raw.trim();
  if (rawTrimmed === '') return undefined;
  const byValue = options.filter((o) => String(o.value) === rawTrimmed);
  return byValue.length === 1 ? byValue[0] : undefined;
}

/**
 * Turn a raw candidate value from one resolution stage into a final
 * ResolvedAnswer, or null when the candidate cannot answer this question
 * (so the next stage may try). Selects and multiselects require every value
 * to EXACTLY match one option label; text fields accept only plain strings.
 */
function finalize(
  question: Question,
  raw: string | string[] | null | undefined,
  source: ResolvedAnswer['source'],
): ResolvedAnswer | null {
  if (raw === null || raw === undefined) return null;

  if (question.type === 'select') {
    if (typeof raw !== 'string') return null;
    const option = matchOption(raw, question.options ?? []);
    if (option === undefined) return null;
    return { questionId: question.id, source, value: String(option.value) };
  }

  if (question.type === 'multiselect') {
    const values = typeof raw === 'string' ? [raw] : raw;
    if (values.length === 0) return null;
    const matched: string[] = [];
    for (const value of values) {
      const option = matchOption(value, question.options ?? []);
      if (option === undefined) return null;
      matched.push(String(option.value));
    }
    return { questionId: question.id, source, value: matched };
  }

  // text / textarea: only a plain string can fill a single field.
  if (typeof raw !== 'string') return null;
  return { questionId: question.id, source, value: raw };
}

/**
 * Which stored-document kind a file question asks for, or null when the
 * question is not recognizably a resume/cover-letter upload (or ambiguously
 * indicates both). Detection uses the standard field id or whole words in
 * the normalized label — never substrings.
 */
function documentKindForFileQuestion(
  question: Question,
): 'resume' | 'cover_letter' | null {
  const label = normalizeLabel(question.label);
  const words = label.split(' ');
  const indicatesResume =
    question.id === 'resume' ||
    words.includes('resume') ||
    words.includes('cv');
  const indicatesCoverLetter =
    question.id === 'cover_letter' || /\bcover letter\b/.test(label);
  if (indicatesResume && indicatesCoverLetter) return null;
  if (indicatesResume) return 'resume';
  if (indicatesCoverLetter) return 'cover_letter';
  return null;
}

/**
 * Deterministically resolve answers to questions.
 *
 * Resolution order per question:
 *  1) standard greenhouse field ids -> profile
 *  2) exact LABEL_DICTIONARY match -> profile
 *  3) guarded yes/no regexes (authorization/sponsorship) -> profile
 *  4) answers bank, exact normalized-label match -> source 'bank'
 *  5) file questions: matching stored document -> source 'document'
 *  6) profile.custom, exact normalized-label match -> profile
 * A stage only wins when it yields a final valid answer (selects require an
 * exact option match); otherwise the next stage gets a chance.
 *
 * TRUTHFULNESS GUARANTEE: values are only ever copied from the profile, from
 * bank answers the user previously saved, or from documents the user
 * uploaded. Nothing is fabricated or guessed. Any question that cannot be
 * answered — required or optional — goes to `missing` with its `required`
 * flag intact, so callers can split blockers from skippable questions (see
 * `splitMissingByRequired`).
 */
export function resolveAnswers(
  questions: Question[],
  profile: Profile,
  opts?: ResolveOptions,
): ResolutionResult {
  const resolved: ResolvedAnswer[] = [];
  const missing: Question[] = [];

  const customByNormalizedLabel = new Map<string, string>();
  for (const [key, value] of Object.entries(profile.custom)) {
    customByNormalizedLabel.set(normalizeLabel(key), value);
  }

  // Bank labels are stored pre-normalized; first entry wins on duplicates.
  const bankByNormalizedLabel = new Map<string, string | string[]>();
  for (const entry of opts?.bank ?? []) {
    if (!bankByNormalizedLabel.has(entry.normalizedLabel)) {
      bankByNormalizedLabel.set(entry.normalizedLabel, entry.value);
    }
  }

  const documents = opts?.documents ?? [];

  for (const question of questions) {
    // File questions resolve ONLY from stored documents of the matching
    // kind (never from text stages); otherwise they go to a human.
    if (question.type === 'file') {
      // (a) Honor an explicit document pick: the dashboard stores the chosen
      // document's storagePath in the answers bank keyed by the question label.
      const picked = bankByNormalizedLabel.get(normalizeLabel(question.label));
      const pickedPath =
        typeof picked === 'string'
          ? documents.find((d) => d.storagePath === picked)?.storagePath
          : undefined;
      // (b) Else auto-resolve by document kind (resume/cover_letter).
      const kind = documentKindForFileQuestion(question);
      const byKind =
        kind === null ? undefined : documents.find((d) => d.kind === kind);
      const storagePath = pickedPath ?? byKind?.storagePath;
      if (storagePath === undefined) {
        missing.push(question);
      } else {
        resolved.push({
          questionId: question.id,
          source: 'document',
          value: storagePath,
        });
      }
      continue;
    }

    const label = normalizeLabel(question.label);
    const answer =
      finalize(
        question,
        computeProfileValue(question, label, profile),
        'profile',
      ) ??
      finalize(question, bankByNormalizedLabel.get(label), 'bank') ??
      finalize(question, customByNormalizedLabel.get(label), 'profile');

    if (answer === null) {
      missing.push(question);
    } else {
      resolved.push(answer);
    }
  }

  return { resolved, missing };
}

/**
 * Split missing questions into required vs optional using each question's
 * `required` flag. This gives callers (e.g. the API) a clean split without
 * changing the @sower/core ResolutionResult type.
 */
export function splitMissingByRequired(missing: Question[]): {
  required: Question[];
  optional: Question[];
} {
  const required: Question[] = [];
  const optional: Question[] = [];
  for (const question of missing) {
    if (question.required) {
      required.push(question);
    } else {
      optional.push(question);
    }
  }
  return { required, optional };
}
