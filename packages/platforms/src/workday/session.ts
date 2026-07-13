import type { WorkdaySession } from './calypso.js';

/**
 * Vault storage for captured Workday sessions, storage-package-agnostic so both
 * apps/api (the pipeline) and apps/worker (the broker) can use it. A session
 * (cookies + CSRF) is a secret, so it lives in the IAM-locked vault next to the
 * credential — never the database.
 */

/** The minimal vault surface a session store needs (matches @sower/storage). */
export interface SessionVault {
  get(path: string): Promise<Buffer>;
  put(
    path: string,
    data: Buffer | Uint8Array,
    contentType?: string,
  ): Promise<void>;
  exists(path: string): Promise<boolean>;
}

const SAFE_SEGMENT_RE = /^[A-Za-z0-9._-]+$/;

/** Vault key for a tenant's captured session (next to the credential). */
export function sessionStoragePath(tenant: string): string {
  if (!SAFE_SEGMENT_RE.test(tenant)) {
    throw new Error(
      `invalid tenant for session path: ${JSON.stringify(tenant)}`,
    );
  }
  return `accounts/workday/${tenant}/session.json`;
}

/** Persist a captured session (overwrites the prior one). */
export async function saveWorkdaySession(
  vault: SessionVault,
  session: WorkdaySession,
): Promise<void> {
  await vault.put(
    sessionStoragePath(session.tenant),
    Buffer.from(JSON.stringify(session, null, 2)),
    'application/json',
  );
}

/** Load a tenant's session, or null when none is stored. */
export async function loadWorkdaySession(
  vault: SessionVault,
  tenant: string,
): Promise<WorkdaySession | null> {
  const path = sessionStoragePath(tenant);
  if (!(await vault.exists(path))) {
    return null;
  }
  const raw = await vault.get(path);
  return JSON.parse(raw.toString('utf8')) as WorkdaySession;
}
