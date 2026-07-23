import { getProfile, isEmptyProfile } from '@sower/answers';
import type {
  JobSpec,
  Platform,
  ResolutionResult,
  TaskState,
} from '@sower/core';
import { canTransition, transition } from '@sower/core';
import { applicationTasks, documents, events, jobs } from '@sower/db';
import type {
  CalypsoFillResult,
  CalypsoResume,
  SubmitFile,
} from '@sower/platforms';
import {
  CalypsoClient,
  fillViaCalypso,
  getAdapter,
  loadWorkdaySession,
  workdayJobSlug,
} from '@sower/platforms';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { syncTaskCalendarEvent } from './calendar-sync.js';
import { refreshIngestReply } from './ingest-reply.js';
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

export type MarkAppliedOutcome =
  | { kind: 'not_found' }
  /** Already SUBMITTED/CONFIRMED — the idempotent no-op. */
  | { kind: 'already'; state: TaskState }
  | { kind: 'skipped'; state: string }
  | { kind: 'marked'; state: TaskState };

/**
 * Mark a task applied out of band (the human completed the application
 * themselves): the MARK_SUBMITTED transition straight to SUBMITTED. Shared
 * by POST /tasks/:id/mark-applied and the #ingest reply's Mark-as-Complete
 * button. Already-sent tasks (SUBMITTED/CONFIRMED) are a tolerant no-op;
 * the archived DISCARDED/DUPLICATE states are skipped (restore first). The
 * optional note ("where/how") lands on the event's data. After the
 * transition the #ingest reply line flips to "applied" and the calendar
 * event is dropped (both best-effort, never throw).
 */
export async function markTaskApplied(
  deps: Deps,
  taskId: string,
  note?: string,
): Promise<MarkAppliedOutcome> {
  const rows = await deps.db
    .select({ state: applicationTasks.state })
    .from(applicationTasks)
    .where(eq(applicationTasks.id, taskId))
    .limit(1);
  const row = rows[0];
  if (!row) {
    return { kind: 'not_found' };
  }
  const state = row.state as TaskState;
  if (state === 'SUBMITTED' || state === 'CONFIRMED') {
    return { kind: 'already', state };
  }
  if (!canTransition(state, 'MARK_SUBMITTED')) {
    return { kind: 'skipped', state };
  }
  const toState = await transitionTask(
    deps.db,
    taskId,
    state,
    'MARK_SUBMITTED',
    {
      reason: 'manual',
      // Omit the key entirely when absent/blank — event data stays minimal.
      ...(note ? { note } : {}),
    },
  );
  await refreshIngestReply(deps, taskId);
  await syncTaskCalendarEvent(deps, taskId);
  return { kind: 'marked', state: toState };
}

export type DiscardOutcome =
  | { kind: 'not_found' }
  /** Already DISCARDED — the idempotent no-op (still refreshes the reply). */
  | { kind: 'already' }
  | { kind: 'skipped'; state: string }
  | { kind: 'discarded'; state: TaskState };

/**
 * Discard a task (terminal DISCARDED state). Shared by POST
 * /tasks/:id/discard and the #ingest reply's Discard button. Allowed from
 * every non-terminal state except SUBMITTED/CONFIRMED (an application
 * already sent can't be "removed from the queue"); re-discarding is a
 * tolerant no-op that still refreshes the reply (recovers a line whose
 * earlier edit failed). The optional note ("why") lands on the event's
 * data. Reply refresh + calendar drop are best-effort, never throw.
 */
export async function discardTask(
  deps: Deps,
  taskId: string,
  note?: string,
): Promise<DiscardOutcome> {
  const rows = await deps.db
    .select({ state: applicationTasks.state })
    .from(applicationTasks)
    .where(eq(applicationTasks.id, taskId))
    .limit(1);
  const row = rows[0];
  if (!row) {
    return { kind: 'not_found' };
  }
  const state = row.state as TaskState;
  if (state === 'DISCARDED') {
    await refreshIngestReply(deps, taskId);
    return { kind: 'already' };
  }
  if (!canTransition(state, 'DISCARD')) {
    return { kind: 'skipped', state };
  }
  const toState = await transitionTask(deps.db, taskId, state, 'DISCARD', {
    reason: 'manual',
    // Omit the key entirely when absent/blank — event data stays minimal.
    ...(note ? { note } : {}),
  });
  await refreshIngestReply(deps, taskId);
  await syncTaskCalendarEvent(deps, taskId);
  return { kind: 'discarded', state: toState };
}

export type ApproveOutcome =
  | { kind: 'not_found' }
  | { kind: 'skipped'; state: string }
  | {
      kind: 'approved';
      state: TaskState;
      /**
       * 'dry-run': greenhouse/lever/ashby — the payload was built and recorded
       * with ZERO network I/O. 'workday-fill': a real draft application was
       * created and filled over HTTP via the captured session, then STOPPED
       * before finalize — nothing was submitted (finalize is separately gated).
       */
      mode: 'dry-run' | 'workday-fill';
      /** True only for the zero-I/O dry-run. Kept for existing consumers. */
      dryRun: boolean;
      payloadSummary: { fieldCount: number; fileCount: number };
      /** Honest one-line summary of what approve did, for cards/UI. */
      note: string;
      /**
       * Discord approval-card ref stored on the task when the card was
       * posted (null when Discord was disabled / no card exists). Internal —
       * used to edit the card after a dashboard approve; not sent to clients.
       */
      approval: { channelId: string; messageId: string } | null;
    }
  | { kind: 'failed'; error: string };

/**
 * Approve a REVIEW task: atomically claim REVIEW -> FILLING (APPROVED event),
 * run the platform's fill, then move FILLING -> REVIEW (FILLED event). Two
 * platform behaviours, one spine:
 *
 * - greenhouse/lever/ashby: a DRY-RUN — the adapter builds and records the
 *   submission payload REPRESENTATION with ZERO external HTTP (tests assert
 *   fetch is never called).
 * - workday: a real calypso FILL over HTTP with the captured session (start ->
 *   name/email/phone -> questionnaire from the REVIEWED answers -> validate),
 *   STOPPING before finalize. It fills exactly what the human reviewed (the
 *   stored resolution) and never submits — finalize stays separately gated.
 *
 * Either way the task returns to REVIEW so the human can inspect the recorded
 * artifacts before any (separately-gated) submission.
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

  const approval =
    claimed.approvalChannelId != null && claimed.approvalMessageId != null
      ? {
          channelId: claimed.approvalChannelId,
          messageId: claimed.approvalMessageId,
        }
      : null;

  try {
    const jobSpec = claimed.jobSpec;
    if (!jobSpec) {
      throw new Error('task has no job spec (was it ever processed?)');
    }
    const resolution = claimed.resolution;
    if (!resolution) {
      throw new Error('task has no resolution (was it ever processed?)');
    }
    const platform = row.job.platform as Platform;

    // Workday: a real calypso fill over HTTP (fill-then-stop), driven by the
    // answers the human just reviewed. Every other platform: the zero-I/O
    // dry-run. Both return to REVIEW with recorded artifacts.
    if (platform === 'workday') {
      const fill = await fillWorkdayOnApprove(
        deps,
        taskId,
        jobSpec,
        resolution,
      );
      const answered = fill.questionnaire?.answered ?? 0;
      const resumeAttached = fill.sectionsFilled.includes('resume');
      currentState = await transitionTask(db, taskId, currentState, 'FILLED', {
        dryRun: false,
        workday: {
          jobApplicationId: fill.jobApplicationId,
          sectionsFilled: fill.sectionsFilled,
          sectionErrors: fill.sectionErrors,
          resumeAttached,
          answered,
          skippedRequired: fill.questionnaire?.skippedRequired ?? 0,
        },
      });
      return {
        kind: 'approved',
        state: currentState,
        mode: 'workday-fill',
        dryRun: false,
        payloadSummary: {
          fieldCount: answered,
          fileCount: resumeAttached ? 1 : 0,
        },
        note: `Workday draft filled: ${fill.sectionsFilled.length} info section(s)${resumeAttached ? ' incl. résumé' : ''}, ${answered} question(s) answered — stopped before submit (finalize is separately gated).`,
        approval,
      };
    }

    const adapter = getAdapter(platform);
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
    const fieldCount = Object.keys(payload).length;
    return {
      kind: 'approved',
      state: currentState,
      mode: 'dry-run',
      dryRun: true,
      payloadSummary: { fieldCount, fileCount: files.length },
      note: `Dry-run submit recorded (${fieldCount} field(s), ${files.length} file(s)); no real application was sent.`,
      approval,
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
 * Run the Workday calypso fill for an approved task and return the result. The
 * answers are the ones the human REVIEWED (the stored resolution), keyed by
 * question id (== the questionnaire field id) — so the fill submits exactly
 * what was approved, never a live re-resolution. Loads the per-tenant session
 * from the vault (throws with a clear "capture a session" message when absent)
 * and records every calypso call as an api_calls row. Never finalizes — the
 * shared `fillViaCalypso` has no finalize in its client surface.
 */
async function fillWorkdayOnApprove(
  deps: Deps,
  taskId: string,
  jobSpec: JobSpec,
  resolution: ResolutionResult,
): Promise<CalypsoFillResult> {
  if (!deps.storage) {
    throw new Error(
      'workday fill needs vault storage, but no session store is configured',
    );
  }
  const session = await loadWorkdaySession(deps.storage, jobSpec.tenant);
  if (!session) {
    throw new Error(
      `no captured Workday session for tenant '${jobSpec.tenant}' — capture one via the session broker, then approve again`,
    );
  }

  const externalPath = jobSpec.meta?.externalPath;
  if (typeof externalPath !== 'string' || externalPath.length === 0) {
    throw new Error('workday job spec is missing meta.externalPath (job slug)');
  }
  const questionnaireId =
    typeof jobSpec.meta?.questionnaireId === 'string'
      ? jobSpec.meta.questionnaireId
      : undefined;

  // DB-first profile (config.PROFILE_PATH is only the dev fallback).
  // getProfile never throws, but a Workday fill writes the profile's
  // name/email/phone into a REAL draft application — filling blanks would be
  // worse than failing, so an unconfigured profile fails the approve with an
  // actionable message (caught below into lastError, like a missing session).
  const profile = await getProfile(deps.db, deps.config.PROFILE_PATH);
  if (isEmptyProfile(profile)) {
    throw new Error(
      'no profile configured — set one up in Answers → Profile before approving a Workday fill (the applicant name/email/phone come from the profile)',
    );
  }

  // The reviewed answers, keyed by question id. Workday questionnaire fields
  // never map to multiselect, so values are strings; arrays (if any) are
  // dropped rather than guessed.
  const valueById: Record<string, string> = {};
  for (const answer of resolution.resolved) {
    if (typeof answer.value === 'string') {
      valueById[answer.questionId] = answer.value;
    }
  }

  // The résumé is a Workday "My Information" attachment, NOT a questionnaire
  // question, so it isn't in the resolution — load the stored résumé directly.
  const resume = await loadResumeForUpload(deps.db, deps.storage);

  const recorder = createTaskRecorder(deps.db, taskId);
  const client = new CalypsoClient(session, { recorder });
  return fillViaCalypso(client, {
    jobSlug: workdayJobSlug(externalPath),
    questionnaireId,
    applicant: {
      firstName: profile.name.first,
      lastName: profile.name.last,
      email: profile.email,
      phone: profile.phone,
    },
    resume,
    // Fill exactly what was reviewed — no live re-resolution.
    resolveQuestionnaireAnswers: () => valueById,
  });
}

/**
 * Load the user's most recent stored résumé (bytes from the vault) for a
 * Workday attachment, or undefined when none is stored (the fill then skips the
 * résumé section). Single-user system: the newest kind='resume' document wins.
 */
async function loadResumeForUpload(
  db: Db,
  storage: NonNullable<Deps['storage']>,
): Promise<CalypsoResume | undefined> {
  const rows = await db
    .select({
      filename: documents.filename,
      storagePath: documents.storagePath,
      contentType: documents.contentType,
    })
    .from(documents)
    .where(eq(documents.kind, 'resume'))
    .orderBy(desc(documents.createdAt))
    .limit(1);
  const doc = rows[0];
  if (!doc) {
    return undefined;
  }
  const bytes = await storage.get(doc.storagePath);
  return {
    fileName: doc.filename,
    contentType: doc.contentType ?? 'application/pdf',
    bytes,
  };
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
