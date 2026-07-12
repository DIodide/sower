import type { PlatformRef } from '@sower/core';

/**
 * Compute a stable identity for a job posting, used by ingest to dedupe
 * jobs that arrive via different URLs for the same underlying posting
 * (e.g. boards.greenhouse.io vs job-boards.greenhouse.io hosts).
 *
 * Precedence:
 * - platform + tenant + externalId -> "platform:tenant:externalId"
 * - platform + externalId only     -> "platform:jid:externalId"
 * - otherwise                      -> the canonical URL
 *
 * Pure and deterministic: same ref + canonical URL always yields the same
 * key, so the jobs.dedupe_key UNIQUE constraint can arbitrate races.
 */
export function computeDedupeKey(
  ref: PlatformRef,
  canonicalUrl: string,
): string {
  if (ref.platform !== 'unknown' && ref.externalId) {
    return ref.tenant
      ? `${ref.platform}:${ref.tenant}:${ref.externalId}`
      : `${ref.platform}:jid:${ref.externalId}`;
  }
  return canonicalUrl;
}
