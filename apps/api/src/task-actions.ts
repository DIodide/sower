import type { Platform, ResolutionResult, TaskState } from '@sower/core';
import { transition } from '@sower/core';
import { applicationTasks, documents, events, jobs } from '@sower/db';
import type { SubmitFile } from '@sower/platforms';
import { getAdapter } from '@sower/platforms';
import { and, eq, inArray } from 'drizzle-orm';
import { createTaskRecorder } from './recorder.js';
import { transitionTask } from './transitions.js';
import type { Db, Deps } from './types.js';

/** States a task may be requeued from (both have RETRY -> QUEUED edges). */
const REQUEUE_STATES: TaskState[] = ['NEEDS_INPUT', 'FAILED'];

export type RequeueOutcome =
  | { kind: 'not_found' }
  | { kind: 'skipped'; state: string }
  | { kind: 'requeued'; state: TaskState };

/**
 * Requeue a NEEDS_INPUT or FAILED task: atomically claim it back to QUEUED
 * with the attempt counter reset, record the RETRY transition, and enqueue
 * processing. A task in any other state is skipped (zero rows claimed).
 */
export async function requeueTask(
  deps: Deps,
  taskId: string,
): Promise<RequeueOutcome> {
  const { db, queue } = deps;

  const rows = await db
    .select({ state: applicationTasks.state })
    .from(applicationTasks)
    .where(eq(applicationTasks.id, taskId))
    .limit(1);
  const row = rows[0];
  if (!row) {
    return { kind: 'not_found' };
  }
  const fromState = row.state as TaskState;

  // ATOMIC claim: concurrent requeues race on this single statement; exactly
  // one wins. attempt resets to 0 so retries get a full attempt budget.
  const claimedRows = await db
    .update(applicationTasks)
    .set({ state: 'QUEUED', attempt: 0, updatedAt: new Date() })
    .where(
      and(
        eq(applicationTasks.id, taskId),
        inArray(applicationTasks.state, REQUEUE_STATES),
      ),
    )
    .returning();
  if (!claimedRows[0]) {
    return { kind: 'skipped', state: fromState };
  }

  // transition() enforcement: NEEDS_INPUT/FAILED + RETRY -> QUEUED. An
  // illegal pair throws (bug signal), never silently records a bogus event.
  const toState = transition(fromState, 'RETRY');
  await db.insert(events).values({
    taskId,
    type: 'RETRY',
    fromState,
    toState,
    data: { attemptReset: true },
  });
  await queue.enqueueProcess(taskId);
  return { kind: 'requeued', state: toState };
}

export type ApproveOutcome =
  | { kind: 'not_found' }
  | { kind: 'skipped'; state: string }
  | {
      kind: 'approved';
      state: TaskState;
      dryRun: true;
      payloadSummary: { fieldCount: number; fileCount: number };
    }
  | { kind: 'failed'; error: string };

/**
 * Approve a REVIEW task and perform a DRY-RUN submit: atomically claim
 * REVIEW -> FILLING (APPROVED event), build the file attachment metadata from
 * resolution entries with source 'document', have the adapter construct and
 * record the submission payload REPRESENTATION, then move FILLING -> REVIEW
 * (FILLED event, data { dryRun: true }).
 *
 * SAFETY: this path performs ZERO external HTTP requests. dryRunSubmit only
 * builds the payload and hands one { phase: 'submit_dryrun', dryRun: true }
 * record to the recorder — tests assert fetch is never called.
 */
export async function approveTask(
  deps: Deps,
  taskId: string,
): Promise<ApproveOutcome> {
  const { db } = deps;

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

  // ATOMIC claim: only a REVIEW task may be approved; concurrent approvals
  // race on this single statement and exactly one wins.
  const fillingState = transition('REVIEW', 'APPROVED');
  const claimedRows = await db
    .update(applicationTasks)
    .set({ state: fillingState, updatedAt: new Date() })
    .where(
      and(
        eq(applicationTasks.id, taskId),
        eq(applicationTasks.state, 'REVIEW'),
      ),
    )
    .returning();
  const claimed = claimedRows[0];
  if (!claimed) {
    return { kind: 'skipped', state: row.task.state };
  }

  let currentState: TaskState = fillingState;
  await db.insert(events).values({
    taskId,
    type: 'APPROVED',
    fromState: 'REVIEW',
    toState: currentState,
    data: null,
  });

  try {
    const jobSpec = claimed.jobSpec;
    if (!jobSpec) {
      throw new Error('task has no job spec (was it ever processed?)');
    }
    const resolution = claimed.resolution;
    if (!resolution) {
      throw new Error('task has no resolution (was it ever processed?)');
    }
    const adapter = getAdapter(row.job.platform as Platform);
    if (!adapter) {
      throw new Error(`no adapter for platform '${row.job.platform}'`);
    }

    const files = await buildSubmitFiles(db, resolution);
    const recorder = createTaskRecorder(db, taskId);
    const { payload } = await adapter.dryRunSubmit(
      jobSpec,
      resolution.resolved,
      files,
      { recorder },
    );

    currentState = await transitionTask(db, taskId, currentState, 'FILLED', {
      dryRun: true,
    });
    return {
      kind: 'approved',
      state: currentState,
      dryRun: true,
      payloadSummary: {
        fieldCount: Object.keys(payload).length,
        fileCount: files.length,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await transitionTask(
      db,
      taskId,
      currentState,
      'FAIL',
      { error: message },
      { lastError: message },
    );
    return { kind: 'failed', error: message };
  }
}

/**
 * File attachments for the dry-run payload: every resolution entry with
 * source 'document' carries its storage path as the value; the filename is
 * looked up from the documents table (falling back to the path's last
 * segment). File CONTENTS never leave the vault here — metadata only.
 */
async function buildSubmitFiles(
  db: Db,
  resolution: ResolutionResult,
): Promise<SubmitFile[]> {
  const documentAnswers = resolution.resolved.filter(
    (answer) =>
      answer.source === 'document' && typeof answer.value === 'string',
  );
  if (documentAnswers.length === 0) {
    return [];
  }
  const paths = documentAnswers.map((answer) => answer.value as string);
  const docRows = await db
    .select({
      storagePath: documents.storagePath,
      filename: documents.filename,
    })
    .from(documents)
    .where(inArray(documents.storagePath, paths));
  const filenameByPath = new Map(
    docRows.map((doc) => [doc.storagePath, doc.filename]),
  );
  return documentAnswers.map((answer) => {
    const storagePath = answer.value as string;
    return {
      questionId: answer.questionId,
      storagePath,
      filename:
        filenameByPath.get(storagePath) ??
        storagePath.split('/').at(-1) ??
        storagePath,
    };
  });
}
