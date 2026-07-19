'use server';

// Server actions for the profile editor. Reads and saves go through the sower
// api's /profile routes (API_BASE_URL, x-api-key auth via the shared
// apiRequest client) — the same pattern as the answer library. The api is the
// single writer of the profiles row; the dashboard never touches it directly.
//
// TRUTHFULNESS: this page only stores what the user typed, validated against
// the SAME ProfileSchema the resolver reads with — a profile that saves here
// can never be rejected at resolution time.

import { emptyProfile, type Profile, ProfileSchema } from '@sower/answers';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { apiRequest } from '../library';
import type { FieldError } from './form-model';

export type ProfileLoadResult =
  | {
      ok: true;
      profile: Profile;
      /** ISO timestamp of the stored row's last save; null when none. */
      updatedAt: string | null;
      /** False when no profiles row exists yet (empty profile served). */
      configured: boolean;
    }
  | { ok: false; message: string };

export interface SaveProfileResult {
  ok: boolean;
  message: string;
  /** ProfileSchema violations keyed by dot path, for per-field display. */
  fieldErrors?: FieldError[];
}

const getResponseSchema = z.object({
  profile: z.unknown(),
  updatedAt: z.string().nullable(),
  configured: z.boolean(),
});

/** Load the stored profile (or the empty profile when none exists yet). */
export async function getProfileAction(): Promise<ProfileLoadResult> {
  const result = await apiRequest('/profile');
  if (!result.ok) return { ok: false, message: result.message };

  const envelope = getResponseSchema.safeParse(result.body);
  if (!envelope.success) {
    return {
      ok: false,
      message: 'the api returned an unexpected /profile shape.',
    };
  }
  if (!envelope.data.configured) {
    // Nothing stored yet: serve a well-typed blank document to the editor.
    return {
      ok: true,
      profile: emptyProfile(),
      updatedAt: envelope.data.updatedAt,
      configured: false,
    };
  }
  const parsed = ProfileSchema.safeParse(envelope.data.profile);
  if (!parsed.success) {
    // A stored-but-unparseable profile must NOT render as a blank form — a
    // save from that state would silently overwrite the stored data.
    return {
      ok: false,
      message:
        'the stored profile does not match the current schema — fix it via the api before editing here.',
    };
  }
  return {
    ok: true,
    profile: parsed.data,
    updatedAt: envelope.data.updatedAt,
    configured: true,
  };
}

/**
 * Validate and save the full profile document (PUT /profile upserts the
 * single row). Validation failures come back as per-field dot-path errors.
 */
export async function saveProfileAction(
  input: unknown,
): Promise<SaveProfileResult> {
  const parsed = ProfileSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      message: 'the profile has invalid fields — fix the highlighted ones.',
      fieldErrors: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    };
  }

  const result = await apiRequest('/profile', {
    method: 'PUT',
    body: parsed.data,
  });
  if (!result.ok) return { ok: false, message: result.message };

  revalidatePath('/answers/profile');
  return {
    ok: true,
    message: 'profile saved — future resolutions use it immediately.',
  };
}
