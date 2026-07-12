import { loadProfile, resolveAnswers } from '@sower/answers';
import type { Platform, ResolutionResult, TaskState } from '@sower/core';
import { transition } from '@sower/core';
import { applicationTasks, events, jobs } from '@sower/db';
import { getAdapter } from '@sower/platforms';
import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import { transitionTask } from './transitions.js';
import type { Deps } from './types.js';

export const MAX_ATTEMPTS = 5;

/** States a processor may claim a task from. */
const CLAIMABLE_STATES: TaskState[] = ['QUEUED', 'FAILED'];

export type ProcessOutcome =
  | { kind: 'not_found' }
  | { kind: 'skipped'; state: string }
  | { kind: 'processed'; state: TaskState; resolved: number; missing: number }
  | { kind: 'failed'; error: string; attempt: number; gaveUp: boolean };

/**
 * Process a queued task: discover the job spec via the platform adapter,
 * resolve answers from the profile, then move to REVIEW (all REQUIRED answers
 * resolved) or NEEDS_INPUT (some required answers missing — never fabricated).
 *
 * Used by both POST /tasks/process and the inline queue driver.
 */
export async function processTask(
  deps: Deps,
  taskId: string,
): Promise<ProcessOutcome> {
  const { db, config } = deps;

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
  const { job } = row;
  const fromState = row.task.state as TaskState;

  // ATOMIC claim: this single statement is both the concurrency guard and the
  // attempt-cap gate. Concurrent deliveries race on it; exactly one wins.
  const claimedRows = await db
    .update(applicationTasks)
    .set({
      state: 'PREPARING',
      attempt: sql`${applicationTasks.attempt} + 1`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(applicationTasks.id, taskId),
        inArray(applicationTasks.state, CLAIMABLE_STATES),
        lt(applicationTasks.attempt, MAX_ATTEMPTS),
      ),
    )
    .returning();
  const claimed = claimedRows[0];
  if (!claimed) {
    // Not claimable: another worker holds it, it is past processing, or the
    // attempt cap is exhausted.
    return { kind: 'skipped', state: fromState };
  }

  // Record the claim as a state-machine transition from the true fromState of
  // the claimed row (QUEUED first time, FAILED on Cloud Tasks re-delivery).
  let currentState = transition(fromState, 'PROCESS_START');
  await db.insert(events).values({
    taskId,
    type: 'PROCESS_START',
    fromState,
    toState: currentState,
    data: { attempt: claimed.attempt },
  });

  try {
    const adapter = getAdapter(job.platform as Platform);
    if (!adapter) {
      throw new Error(`no adapter for platform '${job.platform}'`);
    }
    const jobSpec = await adapter.discover(
      {
        platform: job.platform as Platform,
        tenant: job.tenant,
        externalId: job.externalId,
      },
      job.url,
    );
    await db
      .update(applicationTasks)
      .set({ jobSpec, updatedAt: new Date() })
      .where(eq(applicationTasks.id, taskId));

    const profile = await loadProfile(config.PROFILE_PATH);
    const { resolved, missing } = await resolveAnswers(
      jobSpec.questions,
      profile,
    );
    // REVIEW gates on REQUIRED answers only; optional gaps never block.
    const requiredMissing = missing.filter((question) => question.required);
    const resolution: ResolutionResult = {
      resolved,
      missing,
      requiredMissingCount: requiredMissing.length,
      optionalMissingCount: missing.length - requiredMissing.length,
    };
    await db
      .update(applicationTasks)
      .set({ resolution, updatedAt: new Date() })
      .where(eq(applicationTasks.id, taskId));

    const event =
      requiredMissing.length === 0 ? 'RESOLVED_ALL' : 'RESOLVED_PARTIAL';
    currentState = await transitionTask(db, taskId, currentState, event, {
      resolved: resolved.length,
      missing: missing.length,
      requiredMissing: requiredMissing.length,
    });
    return {
      kind: 'processed',
      state: currentState,
      resolved: resolved.length,
      missing: missing.length,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await transitionTask(
      db,
      taskId,
      currentState,
      'FAIL',
      { error: message, attempt: claimed.attempt },
      { lastError: message },
    );
    return {
      kind: 'failed',
      error: message,
      attempt: claimed.attempt,
      gaveUp: claimed.attempt >= MAX_ATTEMPTS,
    };
  }
}
