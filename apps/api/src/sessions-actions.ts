import { AccountManager } from '@sower/accounts';
import { loadProfile } from '@sower/answers';
import type { JobSpec } from '@sower/core';
import {
  agentHeartbeats,
  applicationTasks,
  jobs,
  type WorkdaySessionStatus,
  workdaySessions,
} from '@sower/db';
import { saveWorkdaySession, type WorkdaySession } from '@sower/platforms';
import { and, eq, sql } from 'drizzle-orm';
import { requeueTask } from './task-actions.js';
import type { Deps } from './types.js';

/**
 * Workday session bridge (api side). The one thing Workday needs that can't run
 * in the cloud is a HEADFUL, human-in-the-loop browser capture. The dashboard
 * requests a capture; a local agent claims it, drives the headful login on the
 * home IP, and reports the captured session back; the api vaults it and
 * re-enqueues the tenant's parked tasks. All state the dashboard/agent see lives
 * in `workday_sessions`; the session cookies themselves live ONLY in the vault.
 */

/** Conservative freshness horizon — matches @sower/worker isSessionFresh (20m). */
const SESSION_TTL_MS = 20 * 60_000;

export type StartOutcome =
  | { kind: 'not_found' }
  | { kind: 'unsupported'; platform: string }
  | { kind: 'no_storage' }
  | { kind: 'started'; tenant: string; status: WorkdaySessionStatus };

/**
 * Request a headful session capture for a parked Workday task's tenant. Ensures
 * the per-tenant candidate account (vaulted credential) and upserts a
 * `workday_sessions` row to 'requested' for the local agent to claim. Non-
 * Workday tasks are a no-op ('unsupported').
 */
export async function startSessionCapture(
  deps: Deps,
  taskId: string,
): Promise<StartOutcome> {
  const { db, storage, config } = deps;
  const rows = await db
    .select({ task: applicationTasks, job: jobs })
    .from(applicationTasks)
    .innerJoin(jobs, eq(applicationTasks.jobId, jobs.id))
    .where(eq(applicationTasks.id, taskId))
    .limit(1);
  const row = rows[0];
  if (!row) {
    return { kind: 'not_found' };
  }
  if (row.job.platform !== 'workday') {
    return { kind: 'unsupported', platform: row.job.platform };
  }
  if (!storage) {
    return { kind: 'no_storage' };
  }

  const jobSpec = row.task.jobSpec as JobSpec | null;
  const tenant = row.job.tenant ?? jobSpec?.tenant;
  if (!tenant) {
    throw new Error('workday task has no tenant to capture a session for');
  }
  const applyUrl = jobSpec?.applyUrl ?? row.job.url;
  const host = new URL(applyUrl).host;
  const site =
    typeof jobSpec?.meta?.site === 'string' ? jobSpec.meta.site : null;

  // The candidate account email must match the application email (Workday
  // rule), which is the profile email the fill uses. One account per tenant
  // (distinct vaulted password), same email.
  const profile = await loadProfile(config.PROFILE_PATH);
  await new AccountManager(db, storage).ensureAccount({
    platform: 'workday',
    tenant,
    site,
    email: profile.email,
  });

  const now = new Date();
  await db
    .insert(workdaySessions)
    .values({
      tenant,
      host,
      loginUrl: applyUrl,
      status: 'requested',
      requestedAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: workdaySessions.tenant,
      set: {
        host,
        loginUrl: applyUrl,
        status: 'requested',
        requestedAt: now,
        updatedAt: now,
        error: null,
      },
    });

  return { kind: 'started', tenant, status: 'requested' };
}

export type ClaimOutcome =
  | { kind: 'empty' }
  | {
      kind: 'claimed';
      tenant: string;
      host: string;
      loginUrl: string;
      email: string;
      password: string;
    };

/**
 * Atomically claim one pending capture request for the local agent: flips the
 * oldest 'requested' row to 'capturing' (FOR UPDATE SKIP LOCKED, so concurrent
 * agents never grab the same one) and returns the tenant + login target + the
 * vaulted credential to pre-fill. Empty when nothing is pending.
 */
export async function claimSessionRequest(deps: Deps): Promise<ClaimOutcome> {
  const { db, storage } = deps;
  if (!storage) {
    return { kind: 'empty' };
  }
  const claimed = await db
    .update(workdaySessions)
    .set({ status: 'capturing', updatedAt: new Date() })
    .where(
      sql`${workdaySessions.id} = (
        select id from workday_sessions
        where status = 'requested'
        order by requested_at asc
        limit 1
        for update skip locked
      )`,
    )
    .returning();
  const row = claimed[0];
  if (!row) {
    return { kind: 'empty' };
  }
  const credential = await new AccountManager(db, storage).getCredential(
    'workday',
    row.tenant,
  );
  if (!credential) {
    throw new Error(`no credential for workday/${row.tenant}`);
  }
  return {
    kind: 'claimed',
    tenant: row.tenant,
    host: row.host,
    loginUrl: row.loginUrl,
    email: credential.email,
    password: credential.password,
  };
}

/**
 * Store a captured+verified session (the agent verified it from the home IP),
 * mark the tenant 'active', and re-enqueue its parked Workday tasks so the
 * pipeline reads the questionnaire and advances to REVIEW.
 */
export async function completeSessionCapture(
  deps: Deps,
  tenant: string,
  session: WorkdaySession,
): Promise<{ requeued: number }> {
  const { db, storage } = deps;
  if (!storage) {
    throw new Error('workday session complete needs vault storage');
  }
  if (session.tenant !== tenant) {
    throw new Error(
      `session tenant ${session.tenant} does not match ${tenant}`,
    );
  }

  await saveWorkdaySession(storage, session);

  const now = new Date();
  await db
    .update(workdaySessions)
    .set({
      status: 'active',
      capturedAt: now,
      expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
      error: null,
      updatedAt: now,
    })
    .where(eq(workdaySessions.tenant, tenant));
  await new AccountManager(db, storage).setStatus(
    'workday',
    tenant,
    'verified',
  );

  // Re-enqueue the tenant's parked Workday tasks (NEEDS_INPUT -> QUEUED).
  const parked = await db
    .select({ id: applicationTasks.id })
    .from(applicationTasks)
    .innerJoin(jobs, eq(applicationTasks.jobId, jobs.id))
    .where(
      and(
        eq(jobs.platform, 'workday'),
        eq(jobs.tenant, tenant),
        eq(applicationTasks.state, 'NEEDS_INPUT'),
      ),
    );
  let requeued = 0;
  for (const task of parked) {
    const outcome = await requeueTask(deps, task.id);
    if (outcome.kind === 'requeued') {
      requeued += 1;
    }
  }
  return { requeued };
}

/** Mark a tenant's capture failed (agent reported an error/timeout). */
export async function failSessionCapture(
  deps: Deps,
  tenant: string,
  error: string,
): Promise<void> {
  await deps.db
    .update(workdaySessions)
    .set({
      status: 'failed',
      error: error.slice(0, 2000),
      updatedAt: new Date(),
    })
    .where(eq(workdaySessions.tenant, tenant));
}

/** Upsert the local agent's liveness heartbeat (dashboard shows "last seen"). */
export async function recordAgentHeartbeat(
  deps: Deps,
  name: string,
  detail?: string,
): Promise<void> {
  const now = new Date();
  await deps.db
    .insert(agentHeartbeats)
    .values({ name, lastSeenAt: now, detail: detail ?? null })
    .onConflictDoUpdate({
      target: agentHeartbeats.name,
      set: { lastSeenAt: now, detail: detail ?? null },
    });
}
