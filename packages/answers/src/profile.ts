import { readFileSync } from 'node:fs';
import { type Database, profiles } from '@sower/db';
import YAML from 'yaml';
import { z } from 'zod';

export const ProfileSchema = z.object({
  name: z.object({
    first: z.string().min(1),
    last: z.string().min(1),
  }),
  email: z.string().min(1),
  phone: z.string().min(1),
  location: z.object({
    city: z.string().min(1),
    state: z.string().min(1),
    country: z.string().min(1),
  }),
  links: z.object({
    website: z.string().optional(),
    github: z.string().optional(),
    linkedin: z.string().optional(),
    twitter: z.string().optional(),
  }),
  education: z.array(
    z.object({
      school: z.string().min(1),
      degree: z.string().min(1),
      major: z.string().min(1),
      gpa: z.number().optional(),
      startDate: z.string().min(1),
      endDate: z.string().min(1),
    }),
  ),
  work: z.array(
    z.object({
      company: z.string().min(1),
      title: z.string().min(1),
      startDate: z.string().min(1),
      endDate: z.string().optional(),
      description: z.string().optional(),
    }),
  ),
  authorization: z.object({
    usWorkAuthorized: z.boolean(),
    requiresSponsorship: z.boolean(),
    /**
     * US citizenship. Opt-in and distinct from usWorkAuthorized (which does
     * NOT distinguish citizen / green-card / visa). Set only when you want the
     * bank to answer explicit citizenship questions (defense/government
     * Workday postings ask these). Unset => those questions go to a human.
     */
    usCitizen: z.boolean().optional(),
    /**
     * "US Person" per ITAR/EAR: a citizen OR lawful permanent resident OR
     * protected individual. A citizen is always a US person; a green-card
     * holder is a US person but NOT a citizen — so this is a SEPARATE opt-in
     * from usCitizen. Unset => "Are you a U.S. Person?" goes to a human.
     */
    usPerson: z.boolean().optional(),
    /**
     * Whether you currently hold an active US security clearance. Opt-in.
     * When explicitly false, the bank answers "do you possess a clearance?" /
     * "which agency sponsored?" with the form's "I do not possess" option.
     * When true (or unset), the specific level/agency goes to a human — the
     * bank never guesses a clearance level.
     */
    hasActiveSecurityClearance: z.boolean().optional(),
    /**
     * Whether you have EVER been employed by the US Government. Opt-in. When
     * explicitly false, the bank answers government-employment conflict
     * surveys with "I have never been employed by the U.S. Government." When
     * true (or unset), the specific status goes to a human.
     */
    everEmployedByUSGovernment: z.boolean().optional(),
  }),
  graduation: z
    .object({
      /** Anticipated graduation month in YYYY-MM form, e.g. "2028-05". */
      date: z
        .string()
        .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'graduation.date must be YYYY-MM')
        .optional(),
      year: z.number().int().optional(),
    })
    .optional(),
  academics: z
    .object({
      satTotal: z.number().int().optional(),
      actComposite: z.number().int().optional(),
      /**
       * Lower bound of the user's GPA band (e.g. 3.7 for a 3.7–4.0 band).
       * Lets range-bucket selects resolve even when the exact GPA is unset.
       */
      gpaBandLow: z.number().optional(),
    })
    .optional(),
  preferences: z
    .object({
      openToRelocation: z.boolean().optional(),
      howDidYouHear: z.string().optional(),
      preferredLocations: z.array(z.string()).optional(),
      pronouns: z.string().optional(),
    })
    .optional(),
  custom: z.record(z.string()).default({}),
});

export type Profile = z.infer<typeof ProfileSchema>;

/**
 * Load a profile from a YAML file and validate it against ProfileSchema.
 * Throws an Error with a clear message if the file is unreadable, is not
 * valid YAML, or does not conform to the schema.
 */
export function loadProfile(path: string): Profile {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to read profile file at "${path}": ${message}`);
  }

  let data: unknown;
  try {
    data = YAML.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Profile file at "${path}" is not valid YAML: ${message}`);
  }

  const result = ProfileSchema.safeParse(data);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Profile file at "${path}" is invalid: ${issues}`);
  }
  return result.data;
}

/**
 * A well-typed Profile whose every field is empty/default (the arrays and
 * maps empty, the strings '', the required authorization booleans false, the
 * optional sections absent — mirroring ProfileSchema's shape and defaults).
 * It deliberately does NOT pass ProfileSchema validation (the identity
 * fields are min-1), which is exactly what makes it a safe sentinel: no
 * stored profile can ever look empty (see isEmptyProfile). Resolution over
 * it never throws — questions simply fall through to the bank/documents or
 * a human.
 */
export function emptyProfile(): Profile {
  return {
    name: { first: '', last: '' },
    email: '',
    phone: '',
    location: { city: '', state: '', country: '' },
    links: {},
    education: [],
    work: [],
    authorization: { usWorkAuthorized: false, requiresSponsorship: false },
    custom: {},
  };
}

/**
 * True when `profile` is the empty sentinel from emptyProfile() (i.e. no
 * profile is configured). Checked on the identity fields, all of which
 * ProfileSchema requires to be non-empty — so a profile that ever passed
 * validation (DB row or YAML file) can never read as empty.
 */
export function isEmptyProfile(profile: Profile): boolean {
  return (
    profile.name.first === '' &&
    profile.name.last === '' &&
    profile.email === '' &&
    profile.phone === ''
  );
}

/**
 * Load the user's profile, DB-first and NEVER throwing:
 *
 *  1. The newest `profiles` row (by updated_at) wins. Its jsonb `data` is
 *     validated with ProfileSchema; an invalid row logs a warning and yields
 *     emptyProfile() — never an exception, and never a silent fall-through
 *     to a stale file (the DB row is the source of truth once one exists).
 *  2. No row + `fallbackPath`: the YAML file loader runs WRAPPED — a
 *     missing/broken/invalid file logs a warning and yields emptyProfile()
 *     instead of throwing (prod never had the gitignored file; the old
 *     throw burned task attempts with ENOENT).
 *  3. No row + no fallbackPath: emptyProfile().
 *
 * A DB read failure is treated like "no row" (logged), so a transient DB
 * hiccup degrades to the file fallback rather than an exception. Callers
 * can detect the unconfigured case with isEmptyProfile() and surface it
 * (e.g. the resolution note pointing at Answers → Profile).
 */
export async function getProfile(
  db: Database,
  fallbackPath?: string,
): Promise<Profile> {
  let rows: Array<{ data: unknown; updatedAt: Date }> = [];
  try {
    // One row is expected (single-profile-per-deployment); ordering is done
    // here in JS so this package needs no drizzle-orm operator imports.
    rows = await db.select().from(profiles);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[sower] profile DB read failed: ${message}`);
  }
  const row = [...rows].sort(
    (a, b) => b.updatedAt.getTime() - a.updatedAt.getTime(),
  )[0];

  if (row !== undefined) {
    const result = ProfileSchema.safeParse(row.data);
    if (result.success) {
      return result.data;
    }
    const issues = result.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    console.warn(`[sower] stored profile row is invalid: ${issues}`);
    return emptyProfile();
  }

  if (fallbackPath !== undefined) {
    try {
      return loadProfile(fallbackPath);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[sower] profile file fallback failed: ${message}`);
    }
  }
  return emptyProfile();
}
