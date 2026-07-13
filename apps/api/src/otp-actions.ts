import type { TaskState } from '@sower/core';
import { transition } from '@sower/core';
import { applicationTasks, events, jobs } from '@sower/db';
import { and, eq } from 'drizzle-orm';
import type { Deps } from './types.js';

/**
 * OTP relay for account-based platforms (Workday): a browser tier that hits
 * an email-verification wall calls requestOtp (FILLING -> AWAITING_OTP,
 * NEED_OTP event) which posts a Discord "Enter code" card; the code arrives
 * via the Discord modal, the dashboard, or the Gmail reader and lands in
 * submitOtp (AWAITING_OTP -> FILLING, RETRY event), stored as pending_otp for
 * the resumed tier to consume.
 *
 * SAFETY: nothing here talks to any ATS — these functions move task state,
 * store a short-lived code, and post/edit Discord cards only.
 */

/** OTP shape: 4-10 alphanumerics after stripping spaces/dashes. */
const OTP_RE = /^[A-Za-z0-9]{4,10}$/;

/** Normalize a user-entered code ("123 456" / "123-456" -> "123456"). */
export function normalizeOtp(raw: string): string | null {
  const code = raw.replace(/[\s-]/g, '');
  return OTP_RE.test(code) ? code : null;
}

export type RequestOtpOutcome =
  | { kind: 'not_found' }
  | { kind: 'skipped'; state: string }
  | { kind: 'requested'; state: TaskState };

/**
 * Park a FILLING task in AWAITING_OTP and post the Discord OTP card.
 * Card posting is best-effort (skipped silently when Discord is disabled);
 * the state transition is the contract.
 */
export async function requestOtp(
  deps: Deps,
  taskId: string,
): Promise<RequestOtpOutcome> {
  const { db, config, notify } = deps;

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

  // ATOMIC claim: only a FILLING task can ask for an OTP; concurrent
  // requests race on this statement and exactly one wins. The target state
  // comes from the @sower/core table (FILLING --NEED_OTP--> AWAITING_OTP).
  const awaitingState = transition('FILLING', 'NEED_OTP');
  const claimedRows = await db
    .update(applicationTasks)
    .set({
      state: awaitingState,
      otpRequestedAt: new Date(),
      pendingOtp: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(applicationTasks.id, taskId),
        eq(applicationTasks.state, 'FILLING'),
      ),
    )
    .returning();
  if (!claimedRows[0]) {
    return { kind: 'skipped', state: row.task.state };
  }
  await db.insert(events).values({
    taskId,
    type: 'NEED_OTP',
    fromState: 'FILLING',
    toState: awaitingState,
    data: null,
  });

  if (config.DISCORD_ENABLED && notify) {
    try {
      const spec = row.task.jobSpec;
      const { channelId, messageId } = await notify.postOtpRequestCard({
        taskId,
        platform: row.job.platform,
        company: row.job.company ?? spec?.company ?? '(unknown company)',
        title: row.job.title ?? spec?.title ?? '(unknown role)',
        tenant: row.job.tenant ?? spec?.tenant ?? row.job.platform,
      });
      await db
        .update(applicationTasks)
        .set({ otpChannelId: channelId, otpMessageId: messageId })
        .where(eq(applicationTasks.id, taskId));
    } catch (error) {
      console.warn(
        `[sower] OTP card post failed for task ${taskId}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }
  return { kind: 'requested', state: awaitingState };
}

export type SubmitOtpOutcome =
  | { kind: 'not_found' }
  | { kind: 'skipped'; state: string }
  | { kind: 'invalid_code' }
  | { kind: 'submitted'; state: TaskState };

/**
 * Store a user-supplied OTP on an AWAITING_OTP task and resume it
 * (RETRY -> FILLING). Also edits the Discord card ('otp-received'),
 * best-effort.
 */
export async function submitOtp(
  deps: Deps,
  taskId: string,
  rawCode: string,
): Promise<SubmitOtpOutcome> {
  const { db, config, notify } = deps;

  const code = normalizeOtp(rawCode);
  if (!code) {
    return { kind: 'invalid_code' };
  }

  const rows = await db
    .select({ state: applicationTasks.state })
    .from(applicationTasks)
    .where(eq(applicationTasks.id, taskId))
    .limit(1);
  const row = rows[0];
  if (!row) {
    return { kind: 'not_found' };
  }

  // ATOMIC claim mirroring requestOtp: only an AWAITING_OTP task accepts a
  // code; the winning update stores it and resumes FILLING in one statement
  // (AWAITING_OTP --RETRY--> FILLING per the @sower/core table).
  const resumedState = transition('AWAITING_OTP', 'RETRY');
  const claimedRows = await db
    .update(applicationTasks)
    .set({
      state: resumedState,
      pendingOtp: code,
      otpSubmittedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(applicationTasks.id, taskId),
        eq(applicationTasks.state, 'AWAITING_OTP'),
      ),
    )
    .returning();
  const claimed = claimedRows[0];
  if (!claimed) {
    return { kind: 'skipped', state: row.state };
  }
  await db.insert(events).values({
    taskId,
    type: 'RETRY',
    fromState: 'AWAITING_OTP',
    toState: resumedState,
    // The code itself is NEVER logged to events — only its arrival.
    data: { via: 'otp' },
  });

  if (
    config.DISCORD_ENABLED &&
    notify &&
    claimed.otpChannelId &&
    claimed.otpMessageId
  ) {
    try {
      await notify.updateApprovalCard(
        claimed.otpChannelId,
        claimed.otpMessageId,
        'otp-received',
        'task resumed',
      );
    } catch (error) {
      console.warn(
        `[sower] OTP card update failed for task ${taskId}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }
  return { kind: 'submitted', state: resumedState };
}

/**
 * Consume (read-and-clear) a task's pending OTP — the browser tier calls
 * this when it resumes. Compare-and-clear: of two concurrent consumers only
 * the one whose conditional UPDATE matches gets the code (RETURNING yields
 * post-update values in Postgres, so the read must happen first), and a
 * stale code can never be typed twice.
 */
export async function consumePendingOtp(
  deps: Pick<Deps, 'db'>,
  taskId: string,
): Promise<string | null> {
  const rows = await deps.db
    .select({ pendingOtp: applicationTasks.pendingOtp })
    .from(applicationTasks)
    .where(eq(applicationTasks.id, taskId))
    .limit(1);
  const code = rows[0]?.pendingOtp;
  if (!code) {
    return null;
  }
  const cleared = await deps.db
    .update(applicationTasks)
    .set({ pendingOtp: null, updatedAt: new Date() })
    .where(
      and(
        eq(applicationTasks.id, taskId),
        eq(applicationTasks.pendingOtp, code),
      ),
    )
    .returning({ id: applicationTasks.id });
  return cleared[0] ? code : null;
}
