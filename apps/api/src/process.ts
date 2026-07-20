import { createHash } from 'node:crypto';
import type { BankValue } from '@sower/answers';
import { getProfile, isEmptyProfile, resolveAnswers } from '@sower/answers';
import type {
  JobSpec,
  Platform,
  ResolutionResult,
  TaskState,
} from '@sower/core';
import { deadlineFromIsoDate, extractDeadline, transition } from '@sower/core';
import {
  answers,
  applicationTasks,
  documents,
  events,
  jobDescriptions,
  jobs,
} from '@sower/db';
import {
  CalypsoClient,
  deriveGreenhouseTenant,
  getAdapter,
  loadWorkdaySession,
  workdayFieldsToQuestions,
} from '@sower/platforms';
import { computeDedupeKey } from '@sower/sources';
import { and, desc, eq, inArray, lt, ne, or, sql } from 'drizzle-orm';
import { syncCalendarEventsForJob } from './calendar-sync.js';
import { postReviewApprovalCard } from './discord.js';
import { refreshIngestReply } from './ingest-reply.js';
import { trailingNumericJobId } from './link-extract.js';
import { createTaskRecorder } from './recorder.js';
import { transitionTask } from './transitions.js';
import type { Deps } from './types.js';

export const MAX_ATTEMPTS = 5;

/** States a processor may claim a task from. */
const CLAIMABLE_STATES: TaskState[] = ['QUEUED', 'FAILED'];

export type ProcessOutcome =
  | { kind: 'not_found' }
  | { kind: 'skipped'; state: string }
  | { kind: 'processed'; state: TaskState; resolved: number; missing: number }
  | {
      /**
       * The parse succeeded but the posting's employment type is full-time
       * (and nothing says intern), so the task was DISCARDED instead of
       * resolved/enqueued. A final outcome — /tasks/process answers 200 so
       * Cloud Tasks never retries it.
       */
      kind: 'auto_discarded';
      state: TaskState;
      employmentType: string;
    }
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
    // SELF-HEALING for unknown-platform jobs with a trailing numeric id: a
    // greenhouse posting rendered on the company's own domain WITHOUT a
    // gh_jid marker (databricks.com/…/<slug>-7011263002) ingests as
    // platform=unknown and parks. On (re)process, feed the URL's candidate
    // id through the VERIFIED tenant probe: a hit adopts platform + tenant +
    // external id (+ the canonical board URL, collision rules below) and the
    // task processes as a normal greenhouse job; a miss changes nothing —
    // the task falls through to the unchanged unknown-platform outcome.
    if (job.platform === 'unknown') {
      const candidateId = trailingNumericJobId(job.url);
      if (candidateId !== null) {
        const tenant = await deriveGreenhouseTenant(job.url, candidateId);
        if (tenant !== null) {
          await adoptGreenhouseTenant(db, job, tenant, candidateId);
        }
      }
    }

    // SELF-HEALING for tenant-less greenhouse jobs: a task parked with
    // "greenhouse job without tenant (custom domain)" re-enters here after a
    // requeue with jobs.tenant still NULL — discover would throw. Probe the
    // fixed boards API for a VERIFIED tenant first: a hit updates the jobs
    // row and discovery proceeds normally; null re-parks with the same
    // reason (a clean NEEDS_INPUT, never a FAIL/retry loop).
    if (
      job.platform === 'greenhouse' &&
      job.tenant === null &&
      job.externalId !== null
    ) {
      const tenant = await deriveGreenhouseTenant(job.url, job.externalId);
      if (tenant === null) {
        const resolution: ResolutionResult = {
          resolved: [],
          missing: [],
          requiredMissingCount: 0,
          optionalMissingCount: 0,
          note: 'Greenhouse posting on a custom domain: no verified board tenant found, so the boards API is unreachable. Re-ingest the job-boards.greenhouse.io URL for this posting to unblock it.',
        };
        await db
          .update(applicationTasks)
          .set({ resolution, updatedAt: new Date() })
          .where(eq(applicationTasks.id, taskId));
        currentState = await transitionTask(
          db,
          taskId,
          currentState,
          'RESOLVED_PARTIAL',
          { reason: 'greenhouse job without tenant (custom domain)' },
          // This pass completed without failure: drop any stale lastError so
          // the dashboard stops showing an error from an older attempt.
          { lastError: null },
        );
        return {
          kind: 'processed',
          state: currentState,
          resolved: 0,
          missing: 0,
        };
      }
      await adoptGreenhouseTenant(db, job, tenant, job.externalId);
    }

    const adapter = getAdapter(job.platform as Platform);
    if (!adapter) {
      throw new Error(`no adapter for platform '${job.platform}'`);
    }
    // Record every adapter HTTP call as an api_calls row (HAR-style trail).
    // Recording is best-effort and never blocks or fails processing.
    const recorder = createTaskRecorder(db, taskId);
    const jobSpec = await adapter.discover(
      {
        platform: job.platform as Platform,
        tenant: job.tenant,
        externalId: job.externalId,
      },
      job.url,
      { recorder },
    );
    // Workday: the adapter returns account-required with NO questions (they live
    // behind a per-tenant session). When a session is captured for this tenant,
    // read the questionnaire here so its fields flow through resolve/REVIEW like
    // any other platform — the task pipeline stays the single spine. Best-effort:
    // no session / no questionnaireId / a dead session leaves the task parked.
    await enrichWorkdayQuestionnaire(deps, jobSpec);
    await db
      .update(applicationTasks)
      .set({ jobSpec, updatedAt: new Date() })
      .where(eq(applicationTasks.id, taskId));

    // Contract D: reflect the discovered spec back onto the jobs row. A raw-URL
    // ingest records no company/title (Ashby/Lever URL ingests especially), so
    // backfill the blanks; and capture the plain-text description as a new
    // versioned row when it first appears or changes. Best-effort shape: both
    // run inside the processing try, so a DB hiccup here surfaces as a normal
    // FAIL/retry rather than silently dropping the discovered data.
    await backfillJobFields(db, job, jobSpec);
    await recordJobDescription(db, job.id, jobSpec.description);
    if (await persistJobDeadline(db, job, jobSpec)) {
      // A NEW posting deadline is every task's effective deadline (unless a
      // user due_date overrides it) — mirror it onto the calendar. Self-gated
      // and never throws; a calendar hiccup must not fail processing.
      await syncCalendarEventsForJob(deps, job.id);
    }

    // Auto-discard full-time roles: the user hunts internships, so a posting
    // whose employment type says full-time (and whose title/type nowhere says
    // intern — mislabeled internships must survive) is removed from the queue
    // right after the parse persisted its spec/description. A prior RESTORE
    // event means a human already overrode this rule for the task — never
    // re-discard against that decision.
    const fullTimeType = autoDiscardableEmploymentType(jobSpec, job.title);
    if (fullTimeType !== null && !(await hasRestoreEvent(db, taskId))) {
      currentState = await transitionTask(
        db,
        taskId,
        currentState,
        'DISCARD',
        {
          reason: 'auto',
          note: `Employment type: ${fullTimeType}`,
        },
        // A completed (non-failing) pass: clear any stale lastError alongside.
        { lastError: null },
      );
      // Flip the #ingest reply line to "discarded". Best-effort (never
      // throws), but guard anyway — a reply edit must not change the outcome.
      await refreshIngestReply(deps, taskId).catch(() => {});
      return {
        kind: 'auto_discarded',
        state: currentState,
        employmentType: fullTimeType,
      };
    }

    // DB-first profile: the profiles row wins; config.PROFILE_PATH is only
    // the dev fallback. NEVER throws — an unconfigured profile resolves as
    // the empty profile (nothing profile-derived resolves; see the note
    // below) instead of burning attempts with "Failed to read profile file".
    const profile = await getProfile(db, config.PROFILE_PATH);
    // The curated answer bank (loaded once at startup, on deps), the answers
    // bank (user-entered values keyed by normalized label), and stored
    // documents (resume/cover letter files) extend the profile as answer
    // sources. Truthfulness is preserved: nothing is ever guessed.
    //
    // The user bank is COMPANY-AWARE: each row carries its company scope
    // ('' = global) and resolveAnswers matches this job's companyKey — a
    // company-scoped answer resolves ONLY for its own company, and wins over
    // a global answer for the same question (isolation invariant).
    const bankRows = await db
      .select({
        normalizedLabel: answers.normalizedLabel,
        value: answers.value,
        company: answers.company,
      })
      .from(answers);
    const documentRows = await db
      .select({
        kind: documents.kind,
        storagePath: documents.storagePath,
        filename: documents.filename,
      })
      .from(documents);
    // This job's companyKey: the ingest-recorded company, else the discovered
    // spec's (a raw-URL ingest records none), normalized like bank scopes.
    const companyKey = (job.company ?? jobSpec.company ?? '')
      .toLowerCase()
      .trim();
    const { resolved, missing } = await resolveAnswers(
      jobSpec.questions,
      profile,
      {
        bank: bankRows.map((row) => ({
          normalizedLabel: row.normalizedLabel,
          value: row.value as BankValue,
          company: row.company,
        })),
        documents: documentRows,
        answerBank: deps.answerBank,
        company: companyKey,
      },
    );
    // REVIEW gates on REQUIRED answers only; optional gaps never block.
    const requiredMissing = missing.filter((question) => question.required);
    // 'account-required' specs (workday) have NO discoverable questions at this
    // tier — the form is behind an account + browser session. Such a task must
    // NOT flow to REVIEW (which implies "ready to approve & submit"); it parks
    // in NEEDS_INPUT until the account/browser tier can fill it.
    const accountRequired = jobSpec.formAccess === 'account-required';
    const resolution: ResolutionResult = {
      resolved,
      missing,
      requiredMissingCount: requiredMissing.length,
      optionalMissingCount: missing.length - requiredMissing.length,
    };
    const notes: string[] = [];
    if (accountRequired) {
      notes.push(
        'Applying to this Workday job requires a per-tenant candidate account and a browser session, which the account/browser tier has not run yet. The title, company, and description are captured; the application form is not yet automatable.',
      );
    }
    if (isEmptyProfile(profile)) {
      notes.push(
        'No profile configured — set one up in Answers → Profile. Resolution ran without profile facts (only saved answers and documents could auto-fill).',
      );
    }
    if (notes.length > 0) {
      resolution.note = notes.join(' ');
    }
    await db
      .update(applicationTasks)
      .set({ resolution, updatedAt: new Date() })
      .where(eq(applicationTasks.id, taskId));

    const event =
      requiredMissing.length === 0 && !accountRequired
        ? 'RESOLVED_ALL'
        : 'RESOLVED_PARTIAL';
    currentState = await transitionTask(
      db,
      taskId,
      currentState,
      event,
      {
        resolved: resolved.length,
        missing: missing.length,
        requiredMissing: requiredMissing.length,
      },
      // The pass completed without failure: clear any lastError left by a
      // previous FAILED attempt in the SAME update that persists the outcome
      // (live case: Aquatic resolved fine but kept showing an old ENOENT).
      { lastError: null },
    );
    if (currentState === 'REVIEW') {
      // Task entered REVIEW (initial process or requeue -> process): post the
      // Discord approval card and store its ids on the task. Best-effort —
      // skipped silently when Discord is disabled, never fails processing.
      await postReviewApprovalCard(deps, {
        taskId,
        platform: jobSpec.platform,
        company: job.company ?? jobSpec.company ?? null,
        title: job.title ?? jobSpec.title,
        applyUrl: jobSpec.applyUrl,
        resolution,
      });
    }
    // The #ingest reply that announced this task (if any) still labels its
    // link by URL — title/company were unknown at post time. The parse just
    // persisted them (jobSpec + jobs backfill), so upgrade the reply's label
    // to "Title · Company" in place. Best-effort: refreshIngestReply no-ops
    // without an ingest ref and swallows its own errors, but guard anyway —
    // a reply edit must never change processing's outcome.
    await refreshIngestReply(deps, taskId).catch(() => {});
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

/**
 * Adopt a probe-VERIFIED greenhouse identity (platform + tenant + external
 * id) onto a jobs row and mirror it onto the in-memory `job` so discovery
 * continues with it. Serves both self-heals above: the tenant-less
 * greenhouse row (externalId already stored) and the unknown-platform row
 * whose id came from the URL's trailing numeric segment.
 *
 * The row normally also adopts the canonical board URL (url + canonical_url +
 * dedupe_key), so it dedupes with board-hosted pastes from now on. BUT both
 * canonical_url and dedupe_key are UNIQUE — when ANOTHER job already owns the
 * board identity (the same posting was pasted via its board URL), rewriting
 * would violate the constraint, so only the identity columns are set and
 * this row keeps its custom-domain URL. Discovery works either way (the
 * adapter reads tenant+id, not the URL).
 */
async function adoptGreenhouseTenant(
  db: Deps['db'],
  job: {
    id: string;
    url: string;
    platform: string;
    tenant: string | null;
    externalId: string | null;
  },
  tenant: string,
  externalId: string,
): Promise<void> {
  const canonicalUrl = `https://job-boards.greenhouse.io/${tenant}/jobs/${externalId}`;
  const dedupeKey = computeDedupeKey(
    { platform: 'greenhouse', tenant, externalId },
    canonicalUrl,
  );
  const identity = { platform: 'greenhouse', tenant, externalId };
  const collisions = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(
      and(
        ne(jobs.id, job.id),
        or(eq(jobs.canonicalUrl, canonicalUrl), eq(jobs.dedupeKey, dedupeKey)),
      ),
    )
    .limit(1);
  if (collisions.length > 0) {
    await db.update(jobs).set(identity).where(eq(jobs.id, job.id));
    Object.assign(job, identity);
    return;
  }
  await db
    .update(jobs)
    .set({ ...identity, url: canonicalUrl, canonicalUrl, dedupeKey })
    .where(eq(jobs.id, job.id));
  Object.assign(job, identity, { url: canonicalUrl });
}

/**
 * Fold a Workday job's questionnaire into jobSpec.questions when a captured
 * session for its tenant is in the vault. The adapter returns Workday specs as
 * `account-required` with the posting's questionnaireId in meta and no
 * questions (they live behind a per-tenant candidate session). This reads that
 * questionnaire via the `common` GET — which does NOT start an application — so
 * the questions resolve against the bank/profile and the task flows to
 * REVIEW/NEEDS_INPUT exactly like a public form. The pipeline thus stays the
 * single spine across platforms; only the read source differs.
 *
 * Best-effort by design: a missing storage dep, missing questionnaireId,
 * absent session, or an expired session all leave the spec account-required so
 * the task parks in NEEDS_INPUT (surfacing "capture a session" to the human)
 * rather than failing. Submission still requires the session at the fill step.
 */
async function enrichWorkdayQuestionnaire(
  deps: Deps,
  jobSpec: JobSpec,
): Promise<void> {
  if (
    jobSpec.platform !== 'workday' ||
    jobSpec.formAccess !== 'account-required' ||
    jobSpec.questions.length > 0 ||
    !deps.storage
  ) {
    return;
  }
  const questionnaireId = jobSpec.meta?.questionnaireId;
  if (typeof questionnaireId !== 'string' || questionnaireId.length === 0) {
    return;
  }
  const session = await loadWorkdaySession(deps.storage, jobSpec.tenant).catch(
    () => null,
  );
  if (!session) {
    return;
  }
  try {
    const fields = await new CalypsoClient(session).getQuestionnaire(
      questionnaireId,
    );
    jobSpec.questions = workdayFieldsToQuestions(fields);
    // Questions are now known and answerable, so for the pipeline's purposes
    // the task is no longer account-required: it flows to REVIEW/NEEDS_INPUT
    // like a public form. (Submission still needs the session, gated at fill.)
    jobSpec.formAccess = 'public';
  } catch (error) {
    // A dead/expired session (or a transient read failure) must not fail the
    // task — leave it account-required so it parks in NEEDS_INPUT and the human
    // is prompted to re-capture a session.
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      `[sower] workday questionnaire read failed for tenant ${jobSpec.tenant}: ${message}`,
    );
  }
}

const FULL_TIME_RE = /full[\s-]?time/i;
const INTERN_RE = /intern/i;

/**
 * The employment type to auto-discard this parse for, or null to proceed.
 * Fires only when the spec's employmentType reads full-time AND neither the
 * employment type itself nor any known title says intern — a safety against
 * mislabeled internship postings ("Software Engineer Intern" tagged
 * "Full time" must reach a human, not the trash).
 */
export function autoDiscardableEmploymentType(
  spec: JobSpec,
  jobTitle: string | null,
): string | null {
  const employmentType = spec.employmentType;
  if (!employmentType || !FULL_TIME_RE.test(employmentType)) {
    return null;
  }
  if (
    INTERN_RE.test(employmentType) ||
    INTERN_RE.test(spec.title) ||
    (jobTitle !== null && INTERN_RE.test(jobTitle))
  ) {
    return null;
  }
  return employmentType;
}

/**
 * True when the task's history holds a RESTORE event — a human brought it
 * back from DISCARDED once, which permanently exempts it from auto-discard.
 */
async function hasRestoreEvent(
  db: Deps['db'],
  taskId: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: events.id })
    .from(events)
    .where(and(eq(events.taskId, taskId), eq(events.type, 'RESTORE')))
    .limit(1);
  return rows.length > 0;
}

/**
 * Backfill the jobs row's company/title from the discovered JobSpec when the
 * ingest-time values are missing. A raw-URL ingest records no company/title
 * (and Ashby's posting-api has no org display name at all), so without this an
 * Ashby/Lever URL-ingested task would show a BLANK company & title on the
 * dashboard. Only blanks are filled — a value the ingest already recorded is
 * never overwritten, and empty discovered values are ignored. Exported for the
 * form-discovery result endpoint, which backfills from the agent's finding the
 * same way ("— untitled role" rows on unsupported links).
 */
export async function backfillJobFields(
  db: Deps['db'],
  job: { id: string; company: string | null; title: string | null },
  spec: { company?: string; title?: string },
): Promise<void> {
  const updates: { company?: string; title?: string } = {};
  if (!job.company && spec.company) {
    updates.company = spec.company;
  }
  if (!job.title && spec.title) {
    updates.title = spec.title;
  }
  if (Object.keys(updates).length === 0) {
    return;
  }
  await db.update(jobs).set(updates).where(eq(jobs.id, job.id));
}

/**
 * Persist the job's application deadline onto jobs.deadline — CONSERVATIVE
 * on both ends. Source: the spec's explicit ATS deadline field first
 * (normalized via deadlineFromIsoDate), else an explicit "apply by <date>"
 * statement in the description text (extractDeadline in @sower/core; parsed,
 * never inferred). Written ONLY when the jobs row has no deadline yet — a
 * recorded deadline is never silently rewritten. Exported for the
 * form-discovery result endpoint, which persists the agent-scraped
 * deadline/JD markdown through the same rule. Returns true when a deadline
 * was written, so callers can mirror the new effective deadline onto the
 * calendar (syncCalendarEventsForJob).
 */
export async function persistJobDeadline(
  db: Deps['db'],
  job: { id: string; deadline: Date | null | undefined },
  spec: { deadline?: string; description?: string },
): Promise<boolean> {
  if (job.deadline !== null && job.deadline !== undefined) {
    return false;
  }
  const iso =
    (spec.deadline ? deadlineFromIsoDate(spec.deadline) : null) ??
    (spec.description ? extractDeadline(spec.description) : null);
  if (iso === null) {
    return false;
  }
  const deadline = new Date(iso);
  if (Number.isNaN(deadline.getTime())) {
    return false;
  }
  await db.update(jobs).set({ deadline }).where(eq(jobs.id, job.id));
  return true;
}

/**
 * Version the job description. Computes the sha256 of the content and
 * compares it against the latest stored row; a new version (max(version)+1,
 * or 1 when none exists) is inserted ONLY when the content changed. A
 * re-discover that returns identical content stores nothing, so the history
 * captures every real change without duplicating unchanged re-fetches. No
 * content (e.g. an adapter that exposes none) is a no-op. Exported for the
 * form-discovery result endpoint, which stores the agent-scraped markdown
 * through the same versioning.
 */
export async function recordJobDescription(
  db: Deps['db'],
  jobId: string,
  content: string | undefined,
): Promise<void> {
  if (!content) {
    return;
  }
  const contentHash = createHash('sha256').update(content).digest('hex');
  const latestRows = await db
    .select({
      version: jobDescriptions.version,
      contentHash: jobDescriptions.contentHash,
    })
    .from(jobDescriptions)
    .where(eq(jobDescriptions.jobId, jobId))
    .orderBy(desc(jobDescriptions.version))
    .limit(1);
  const latest = latestRows[0];
  if (latest && latest.contentHash === contentHash) {
    // Unchanged since the last discover — store nothing extra.
    return;
  }
  await db.insert(jobDescriptions).values({
    jobId,
    version: latest ? latest.version + 1 : 1,
    content,
    contentHash,
  });
}
