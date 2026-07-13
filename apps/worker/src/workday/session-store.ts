import type { WorkdaySession } from '@sower/platforms';
import type { Storage } from '@sower/storage';

/**
 * Vault storage for captured Workday sessions. A session (cookies + CSRF) is a
 * secret, so it lives in the same IAM-locked vault as the account credential —
 * never the database. Keyed per tenant, next to the credential.
 */

const SAFE_SEGMENT_RE = /^[A-Za-z0-9._-]+$/;

/** Vault key for a tenant's captured session. */
export function sessionStoragePath(tenant: string): string {
  if (!SAFE_SEGMENT_RE.test(tenant)) {
    throw new Error(
      `invalid tenant for session path: ${JSON.stringify(tenant)}`,
    );
  }
  return `accounts/workday/${tenant}/session.json`;
}

/** Persist a captured session to the vault (overwrites the prior one). */
export async function saveWorkdaySession(
  storage: Storage,
  session: WorkdaySession,
): Promise<void> {
  const path = sessionStoragePath(session.tenant);
  await storage.put(
    path,
    Buffer.from(JSON.stringify(session, null, 2)),
    'application/json',
  );
}

/** Load a tenant's session from the vault, or null when none is stored. */
export async function loadWorkdaySession(
  storage: Storage,
  tenant: string,
): Promise<WorkdaySession | null> {
  const path = sessionStoragePath(tenant);
  if (!(await storage.exists(path))) {
    return null;
  }
  const raw = await storage.get(path);
  return JSON.parse(raw.toString('utf8')) as WorkdaySession;
}
