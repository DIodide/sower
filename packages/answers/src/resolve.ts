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

type ProfileValueGetter = (profile: Profile) => string | null;

const cityState: ProfileValueGetter = (p) =>
  `${p.location.city}, ${p.location.state}`;
const school: ProfileValueGetter = (p) => p.education[0]?.school ?? null;
// "Current company" is only truthful for a work entry that has not ended.
const currentCompany: ProfileValueGetter = (p) =>
  p.work.find((w) => w.endDate === undefined)?.company ?? null;

/**
 * Exact normalized-label dictionary. A label resolves only when its
 * normalized form EXACTLY equals one of these keys — never via substring
 * matching, which fabricates answers ("ethnicity" contains "city",
 * "relocation" contains "location", "manager's email" contains "email").
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

/**
 * Compute the raw string value for a question from the profile, or null if
 * the profile holds no answer for it. This is strictly deterministic lookup —
 * it NEVER synthesizes a value that is not present in the profile, and it
 * never matches labels by substring. When in doubt, it returns null so the
 * question is surfaced to a human.
 */
function computeRawValue(
  question: Question,
  profile: Profile,
  customByNormalizedLabel: Map<string, string>,
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
      // Files are never auto-resolved; always surfaced as missing.
      return null;
    case 'location':
    case 'city':
    case 'candidate_location':
    case 'job_application_location':
      return cityState(profile);
    default:
      break;
  }

  const label = normalizeLabel(question.label);

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
    if (mentionsAuthorization) {
      return profile.authorization.usWorkAuthorized ? 'Yes' : 'No';
    }
    return profile.authorization.requiresSponsorship ? 'Yes' : 'No';
  }

  // 4) Custom answers from the profile: exact normalized-label match only.
  return customByNormalizedLabel.get(label) ?? null;
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
  const target = normalizeLabel(raw);
  if (target === '') return undefined;
  const matches = options.filter((o) => normalizeLabel(o.label) === target);
  return matches.length === 1 ? matches[0] : undefined;
}

/**
 * Deterministically resolve answers to questions from a profile.
 *
 * TRUTHFULNESS GUARANTEE: values are only ever copied from the profile.
 * Nothing is fabricated or guessed. Any question that cannot be answered
 * from the profile — including ALL file uploads and any unmatched question,
 * required or optional — goes to `missing` with its `required` flag intact,
 * so callers can split blockers from skippable questions (see
 * `splitMissingByRequired`).
 */
export function resolveAnswers(
  questions: Question[],
  profile: Profile,
): ResolutionResult {
  const resolved: ResolvedAnswer[] = [];
  const missing: Question[] = [];

  const customByNormalizedLabel = new Map<string, string>();
  for (const [key, value] of Object.entries(profile.custom)) {
    customByNormalizedLabel.set(normalizeLabel(key), value);
  }

  for (const question of questions) {
    // File uploads are never auto-resolved.
    if (question.type === 'file') {
      missing.push(question);
      continue;
    }

    const raw = computeRawValue(question, profile, customByNormalizedLabel);
    if (raw === null) {
      missing.push(question);
      continue;
    }

    if (question.type === 'select' || question.type === 'multiselect') {
      const option = matchOption(raw, question.options ?? []);
      if (option === undefined) {
        missing.push(question);
        continue;
      }
      const optionValue = String(option.value);
      resolved.push({
        questionId: question.id,
        source: 'profile',
        value: question.type === 'multiselect' ? [optionValue] : optionValue,
      });
      continue;
    }

    resolved.push({ questionId: question.id, source: 'profile', value: raw });
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
