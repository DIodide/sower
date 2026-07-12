import { readFileSync } from 'node:fs';
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
