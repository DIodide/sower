// Draft <-> Profile conversion for the profile editor. The DRAFT is what the
// form edits — every scalar a string so inputs stay controlled, optional
// booleans a tri-state ('' = not set, so those questions go to a human), and
// the arrays/maps row-shaped for add/remove UI. draftToProfileInput builds
// the ProfileSchema-shaped document the save action validates; nothing here
// invents values — blank optional fields become ABSENT, never defaults.
//
// Pure module, safe to import from the client component: the @sower/answers
// import is type-only (erased at build), so no server-only code is bundled.

import type { Profile } from '@sower/answers';

/** '' = not set (the resolver sends such questions to a human). */
export type TriState = '' | 'yes' | 'no';

export interface EducationDraft {
  school: string;
  degree: string;
  major: string;
  gpa: string;
  startDate: string;
  endDate: string;
}

export interface WorkDraft {
  company: string;
  title: string;
  startDate: string;
  endDate: string;
  description: string;
}

export interface CustomDraft {
  key: string;
  value: string;
}

export interface ProfileDraft {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  city: string;
  state: string;
  country: string;
  website: string;
  github: string;
  linkedin: string;
  twitter: string;
  education: EducationDraft[];
  work: WorkDraft[];
  usWorkAuthorized: boolean;
  requiresSponsorship: boolean;
  usCitizen: TriState;
  usPerson: TriState;
  hasActiveSecurityClearance: TriState;
  everEmployedByUSGovernment: TriState;
  graduationDate: string;
  graduationYear: string;
  satTotal: string;
  actComposite: string;
  gpaBandLow: string;
  openToRelocation: TriState;
  howDidYouHear: string;
  pronouns: string;
  preferredLocations: string[];
  custom: CustomDraft[];
}

export interface FieldError {
  /** Dot path matching ProfileSchema (e.g. 'education.0.gpa'). */
  path: string;
  message: string;
}

export function emptyEducationRow(): EducationDraft {
  return {
    school: '',
    degree: '',
    major: '',
    gpa: '',
    startDate: '',
    endDate: '',
  };
}

export function emptyWorkRow(): WorkDraft {
  return {
    company: '',
    title: '',
    startDate: '',
    endDate: '',
    description: '',
  };
}

function triFromBool(value: boolean | undefined): TriState {
  if (value === undefined) return '';
  return value ? 'yes' : 'no';
}

function triToBool(value: TriState): boolean | undefined {
  if (value === '') return undefined;
  return value === 'yes';
}

export function profileToDraft(profile: Profile): ProfileDraft {
  return {
    firstName: profile.name.first,
    lastName: profile.name.last,
    email: profile.email,
    phone: profile.phone,
    city: profile.location.city,
    state: profile.location.state,
    country: profile.location.country,
    website: profile.links.website ?? '',
    github: profile.links.github ?? '',
    linkedin: profile.links.linkedin ?? '',
    twitter: profile.links.twitter ?? '',
    education: profile.education.map((entry) => ({
      school: entry.school,
      degree: entry.degree,
      major: entry.major,
      gpa: entry.gpa === undefined ? '' : String(entry.gpa),
      startDate: entry.startDate,
      endDate: entry.endDate,
    })),
    work: profile.work.map((entry) => ({
      company: entry.company,
      title: entry.title,
      startDate: entry.startDate,
      endDate: entry.endDate ?? '',
      description: entry.description ?? '',
    })),
    usWorkAuthorized: profile.authorization.usWorkAuthorized,
    requiresSponsorship: profile.authorization.requiresSponsorship,
    usCitizen: triFromBool(profile.authorization.usCitizen),
    usPerson: triFromBool(profile.authorization.usPerson),
    hasActiveSecurityClearance: triFromBool(
      profile.authorization.hasActiveSecurityClearance,
    ),
    everEmployedByUSGovernment: triFromBool(
      profile.authorization.everEmployedByUSGovernment,
    ),
    graduationDate: profile.graduation?.date ?? '',
    graduationYear:
      profile.graduation?.year === undefined
        ? ''
        : String(profile.graduation.year),
    satTotal:
      profile.academics?.satTotal === undefined
        ? ''
        : String(profile.academics.satTotal),
    actComposite:
      profile.academics?.actComposite === undefined
        ? ''
        : String(profile.academics.actComposite),
    gpaBandLow:
      profile.academics?.gpaBandLow === undefined
        ? ''
        : String(profile.academics.gpaBandLow),
    openToRelocation: triFromBool(profile.preferences?.openToRelocation),
    howDidYouHear: profile.preferences?.howDidYouHear ?? '',
    pronouns: profile.preferences?.pronouns ?? '',
    preferredLocations: [...(profile.preferences?.preferredLocations ?? [])],
    custom: Object.entries(profile.custom).map(([key, value]) => ({
      key,
      value,
    })),
  };
}

/** '' -> undefined (absent), otherwise the trimmed string. */
function optional(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function parseNumberField(
  raw: string,
  path: string,
  errors: FieldError[],
  opts?: { integer?: boolean },
): number | undefined {
  const trimmed = raw.trim();
  if (trimmed === '') return undefined;
  const value = Number(trimmed);
  if (Number.isNaN(value)) {
    errors.push({ path, message: 'must be a number' });
    return undefined;
  }
  if (opts?.integer === true && !Number.isInteger(value)) {
    errors.push({ path, message: 'must be a whole number' });
    return undefined;
  }
  return value;
}

/** An optional-section object, or undefined when every field is unset. */
function definedOrAbsent<T extends object>(section: T): T | undefined {
  const hasValue = Object.values(section).some((value) => value !== undefined);
  return hasValue ? section : undefined;
}

/**
 * Build the ProfileSchema-shaped document from the draft. `errors` carries
 * cheap CLIENT-side problems (non-numeric numbers, duplicate custom keys);
 * required-field enforcement is left to ProfileSchema so the form and the
 * api can never disagree about what a valid profile is.
 */
export function draftToProfileInput(draft: ProfileDraft): {
  profile: unknown;
  errors: FieldError[];
} {
  const errors: FieldError[] = [];

  const education = draft.education.map((row, index) => ({
    school: row.school.trim(),
    degree: row.degree.trim(),
    major: row.major.trim(),
    gpa: parseNumberField(row.gpa, `education.${index}.gpa`, errors),
    startDate: row.startDate.trim(),
    endDate: row.endDate.trim(),
  }));

  const work = draft.work.map((row) => ({
    company: row.company.trim(),
    title: row.title.trim(),
    startDate: row.startDate.trim(),
    endDate: optional(row.endDate),
    description: optional(row.description),
  }));

  const custom: Record<string, string> = {};
  for (const [index, row] of draft.custom.entries()) {
    const key = row.key.trim();
    if (key === '') {
      if (row.value.trim() !== '') {
        errors.push({
          path: `custom.${index}.key`,
          message: 'custom answers need a question label',
        });
      }
      continue;
    }
    if (key in custom) {
      errors.push({
        path: `custom.${index}.key`,
        message: 'duplicate question label',
      });
      continue;
    }
    custom[key] = row.value;
  }

  const preferredLocations = draft.preferredLocations
    .map((value) => value.trim())
    .filter((value) => value !== '');

  const profile = {
    name: { first: draft.firstName.trim(), last: draft.lastName.trim() },
    email: draft.email.trim(),
    phone: draft.phone.trim(),
    location: {
      city: draft.city.trim(),
      state: draft.state.trim(),
      country: draft.country.trim(),
    },
    links: {
      website: optional(draft.website),
      github: optional(draft.github),
      linkedin: optional(draft.linkedin),
      twitter: optional(draft.twitter),
    },
    education,
    work,
    authorization: {
      usWorkAuthorized: draft.usWorkAuthorized,
      requiresSponsorship: draft.requiresSponsorship,
      usCitizen: triToBool(draft.usCitizen),
      usPerson: triToBool(draft.usPerson),
      hasActiveSecurityClearance: triToBool(draft.hasActiveSecurityClearance),
      everEmployedByUSGovernment: triToBool(draft.everEmployedByUSGovernment),
    },
    graduation: definedOrAbsent({
      date: optional(draft.graduationDate),
      year: parseNumberField(draft.graduationYear, 'graduation.year', errors, {
        integer: true,
      }),
    }),
    academics: definedOrAbsent({
      satTotal: parseNumberField(draft.satTotal, 'academics.satTotal', errors, {
        integer: true,
      }),
      actComposite: parseNumberField(
        draft.actComposite,
        'academics.actComposite',
        errors,
        { integer: true },
      ),
      gpaBandLow: parseNumberField(
        draft.gpaBandLow,
        'academics.gpaBandLow',
        errors,
      ),
    }),
    preferences: definedOrAbsent({
      openToRelocation: triToBool(draft.openToRelocation),
      howDidYouHear: optional(draft.howDidYouHear),
      preferredLocations:
        preferredLocations.length > 0 ? preferredLocations : undefined,
      pronouns: optional(draft.pronouns),
    }),
    custom,
  };

  return { profile, errors };
}
