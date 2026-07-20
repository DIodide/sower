import type {
  JobSpec,
  Question,
  ResolutionResult,
  TaskPriority,
  TaskState,
} from '@sower/core';
import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

export const jobs = pgTable('jobs', {
  id: uuid('id').primaryKey().defaultRandom(),
  url: text('url').notNull(),
  canonicalUrl: text('canonical_url').notNull().unique(),
  company: text('company'),
  title: text('title'),
  platform: text('platform').notNull(),
  tenant: text('tenant'),
  externalId: text('external_id'),
  terms: jsonb('terms').$type<string[]>(),
  source: text('source').notNull().default('manual'),
  /**
   * Stable identity for ingest dedupe, computed by
   * `computeDedupeKey` (@sower/sources): `platform:tenant:externalId`,
   * `platform:jid:externalId`, or the canonical URL as a fallback.
   * Nullable so pre-existing rows can be backfilled lazily; unique so a
   * concurrent double-ingest cannot create two rows for the same posting.
   */
  dedupeKey: text('dedupe_key').unique(),
  /**
   * Application deadline (UTC midnight of the published date). Nullable —
   * most postings state none. Written ONLY from explicit sources (an ATS
   * deadline field or an "apply by <date>" statement in the JD, see
   * extractDeadline in @sower/core), and only when currently null, so a
   * recorded deadline is never silently rewritten.
   */
  deadline: timestamp('deadline', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

/**
 * One row per source poll (the hourly ingestion run). Records the funnel so the
 * dashboard can show ingestion history without re-deriving it from jobs/events.
 * Fire-and-forget audit: a failed write never blocks the poll.
 */
export const ingestionRuns = pgTable('ingestion_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  /** Term filters applied this run (config SIMPLIFY_TERMS). */
  terms: jsonb('terms').$type<string[]>().notNull(),
  /** Source repo names polled (SOURCES[].name). */
  sources: jsonb('sources').$type<string[]>().notNull(),
  /** Listings matching the term filter after activeOnly. */
  scanned: integer('scanned').notNull(),
  /** Auto-ingestable candidates (supported platform + resolvable tenant). */
  matched: integer('matched').notNull(),
  /** New jobs created this run. */
  ingested: integer('ingested').notNull(),
  /** Candidates already known (dedupe hits). */
  duplicates: integer('duplicates').notNull(),
  /** Listings not auto-ingested (no adapter / no tenant). */
  skipped: integer('skipped').notNull(),
  /** Per-platform counts across all scanned listings. */
  byPlatform: jsonb('by_platform').$type<Record<string, number>>().notNull(),
  /** Wall-clock time the poll took. */
  durationMs: integer('duration_ms').notNull(),
  /** False when the poll threw before completing (see `error`). */
  ok: boolean('ok').notNull().default(true),
  error: text('error'),
});

export const applicationTasks = pgTable('application_tasks', {
  id: uuid('id').primaryKey().defaultRandom(),
  jobId: uuid('job_id')
    .notNull()
    .references(() => jobs.id),
  state: text('state').$type<TaskState>().notNull(),
  attempt: integer('attempt').notNull().default(0),
  jobSpec: jsonb('job_spec').$type<JobSpec>(),
  resolution: jsonb('resolution').$type<ResolutionResult>(),
  lastError: text('last_error'),
  /**
   * Discord approval-card location (set when the task enters REVIEW and a
   * card is posted), so the card can be edited after approve/reject. Null
   * when Discord notification is disabled or the post failed.
   */
  approvalChannelId: text('approval_channel_id'),
  approvalMessageId: text('approval_message_id'),
  /**
   * OTP relay for account-based platforms (whitepaper AWAITING_OTP): when a
   * browser tier hits an email-verification wall it parks the task and an OTP
   * request card is posted; the user's code lands here (via Discord modal,
   * dashboard, or the Gmail reader) and the resumed FILLING tier consumes it.
   * OTPs are short-lived single-use codes — storing one briefly is safe; the
   * consumer clears it after use.
   */
  pendingOtp: text('pending_otp'),
  otpRequestedAt: timestamp('otp_requested_at', { withTimezone: true }),
  otpSubmittedAt: timestamp('otp_submitted_at', { withTimezone: true }),
  /** Discord OTP-request card location, so the card can be edited on submit. */
  otpChannelId: text('otp_channel_id'),
  otpMessageId: text('otp_message_id'),
  /**
   * The #ingest reply message this task was announced in (set best-effort by
   * the Discord ingest poll), so refreshIngestReply can re-render + edit that
   * reply as the task's state advances (form discovered, human verified, ...).
   * Null for tasks that did not arrive via #ingest or when the reply failed.
   */
  ingestChannelId: text('ingest_channel_id'),
  ingestMessageId: text('ingest_message_id'),
  /** Freeform user notes (dashboard-only; never sent to any platform). */
  notes: text('notes'),
  /**
   * User-facing priority: 2=highest, 1=high, 0=normal, -1=low (@sower/core
   * TaskPriority). An int (not an enum) so `ORDER BY priority DESC` sorts
   * Highest → Low — a new level needs no migration.
   */
  priority: integer('priority').$type<TaskPriority>().notNull().default(0),
  /**
   * Manual position within the dashboard's "Waiting on you" section, set by
   * drag-and-drop (POST /tasks/:id/reorder). A rank only orders rows WITHIN
   * a priority tier — the section sorts priority desc first, then inside
   * each tier the UNRANKED rows (null here: new/untriaged, created_at desc,
   * so a fresh ingest surfaces at the top of its tier) ahead of the ranked
   * block (sort_rank asc — the hand-placed rows). Double precision so a
   * drop between neighbors is a midpoint write; the api resequences the
   * tier to 1024-spaced integers when midpoints run out of room. An
   * explicit priority change clears the rank (the row re-enters its new
   * tier at the top); a drag across a tier boundary adopts the destination
   * tier's priority together with the new rank in one update.
   */
  sortRank: doublePrecision('sort_rank'),
  /**
   * The USER'S own due date for this application (dashboard ⏰ chip / task
   * header), distinct from jobs.deadline (the POSTING'S parsed deadline,
   * never user-editable). Nullable; when set it wins over jobs.deadline
   * everywhere the dashboard displays a deadline. Stored UTC-midnight like
   * jobs.deadline so both render identically.
   */
  dueDate: timestamp('due_date', { withTimezone: true }),
  /**
   * Google Calendar event mirroring this task's EFFECTIVE deadline (due_date
   * if set, else jobs.deadline) — written by the api's calendar sync, which
   * upserts the event as the deadline/state changes and deletes it when the
   * task no longer needs one (submitted/discarded/deadline cleared). Null
   * when no event exists (sync disabled, no deadline, or already removed).
   */
  calendarEventId: text('calendar_event_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
});

export const events = pgTable(
  'events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => applicationTasks.id),
    // Spec: free text. In practice always a TaskEvent recorded via the
    // @sower/core transition table (e.g. PARSE_OK, PARK, PROCESS_START, FAIL).
    type: text('type').notNull(),
    fromState: text('from_state').$type<TaskState>(),
    toState: text('to_state').$type<TaskState>(),
    data: jsonb('data'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  // The task detail + tenant pages read a task's events by task_id.
  (table) => [index('events_task_id_idx').on(table.taskId)],
);

export const answers = pgTable(
  'answers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /**
     * Normalized company key scoping this answer: the job's company
     * lowercased and trimmed, or '' for a GLOBAL answer that applies to any
     * company. Company-scoped answers (essays like "Why do you want to work
     * here?") resolve ONLY for their company; a global answer resolves for
     * any company but loses to a company-scoped match (see the user-bank
     * stage in @sower/answers resolve.ts). Rows written before migration
     * 0006 default to '' and stay global.
     */
    company: text('company').notNull().default(''),
    questionLabel: text('question_label').notNull(),
    normalizedLabel: text('normalized_label').notNull(),
    value: jsonb('value').notNull(),
    source: text('source').notNull().default('user'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (table) => [
    // One answer per (company, question): upserts key on this pair, so a
    // concurrent double-save cannot create two rows for the same scope.
    uniqueIndex('answers_company_normalized_label_uq').on(
      table.company,
      table.normalizedLabel,
    ),
  ],
);

export const apiCalls = pgTable(
  'api_calls',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => applicationTasks.id),
    seq: integer('seq').notNull(),
    phase: text('phase').notNull(),
    method: text('method').notNull(),
    url: text('url').notNull(),
    requestHeaders: jsonb('request_headers').$type<Record<string, string>>(),
    requestBody: jsonb('request_body'),
    responseStatus: integer('response_status'),
    responseHeaders: jsonb('response_headers').$type<Record<string, string>>(),
    responseBody: jsonb('response_body'),
    durationMs: integer('duration_ms'),
    dryRun: boolean('dry_run').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  (table) => [index('api_calls_task_id_idx').on(table.taskId)],
);

export const documents = pgTable(
  'documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: text('kind').notNull(),
    filename: text('filename').notNull(),
    storagePath: text('storage_path').notNull(),
    contentType: text('content_type'),
    sizeBytes: integer('size_bytes'),
    /**
     * The job this document belongs to (e.g. a 'screenshot' captured from a
     * Discord ingest attachment). Null for job-agnostic documents like the
     * resume/cover-letter library uploads.
     */
    jobId: uuid('job_id').references(() => jobs.id),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  },
  // The task detail page reads a job's screenshots by job_id.
  (table) => [index('documents_job_id_idx').on(table.jobId)],
);

export const jobDescriptions = pgTable(
  'job_descriptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => jobs.id),
    /**
     * Monotonic per-job version, starting at 1. process.ts inserts a new
     * version (max(version)+1) only when a re-discover yields a description
     * whose content_hash differs from the latest stored row, so the history
     * captures every change without duplicating unchanged re-fetches.
     */
    version: integer('version').notNull(),
    // Plain-text description (JobSpec.description) as fetched from the source.
    content: text('content').notNull(),
    // sha256 of `content`, used to detect whether a re-discover changed it.
    contentHash: text('content_hash').notNull(),
    fetchedAt: timestamp('fetched_at', { withTimezone: true }).defaultNow(),
  },
  (table) => [
    // The task detail page reads the latest description by job_id.
    index('job_descriptions_job_id_idx').on(table.jobId),
    // One row per (job, version): a concurrent double-discover can't create
    // two rows for the same version.
    uniqueIndex('job_descriptions_job_id_version_uq').on(
      table.jobId,
      table.version,
    ),
  ],
);

/**
 * Outcome of a Tier-2 screenshot investigation. Mirrors
 * InvestigationResult in @sower/investigate — re-declared locally so
 * @sower/db stays dependency-light (no agent-SDK transitives).
 */
export interface InvestigationResult {
  /** true ONLY if a real application URL was located. */
  found: boolean;
  applyUrl?: string;
  company?: string;
  title?: string;
  /** greenhouse | lever | ashby | workday | other (best guess). */
  platform?: string;
  confidence: 'high' | 'medium' | 'low';
  notes: string;
}

/**
 * Outcome of a Tier-2 form discovery of an UNSUPPORTED job link. Mirrors
 * DiscoveredForm in @sower/investigate — re-declared locally (like
 * InvestigationResult) so @sower/db stays dependency-light.
 */
export interface DiscoveredForm {
  formFound: boolean;
  /** The URL where the form lives (after any Apply hop). */
  applyUrl?: string;
  company?: string;
  title?: string;
  /**
   * JD markdown scraped programmatically from the details page (~20k cap).
   * The result endpoint also persists it as a job_descriptions row.
   */
  descriptionMarkdown?: string;
  /** Employment type when the page exposes one (future extraction). */
  employmentType?: string;
  /**
   * ISO UTC-midnight application deadline parsed from an explicit
   * "apply by <date>"-style statement in the scraped JD (never inferred).
   */
  deadline?: string;
  /**
   * When the apply flow landed on (or embedded) a SUPPORTED ATS host
   * (workday/greenhouse/lever/ashby): the cleaned posting URL there, so the
   * result endpoint can ingest it as a real supported task.
   */
  handoffUrl?: string;
  /**
   * Structured page classification (agent-set via the JSON contract;
   * programmatic signals override: HTTP-blocked ⇒ 'blocked', a qualifying
   * listing-link extraction ⇒ 'listing').
   */
  pageKind?:
    | 'application'
    | 'posting'
    | 'listing'
    | 'login'
    | 'blocked'
    | 'other';
  /**
   * Individual job links extracted from the RENDERED DOM of a jobs LISTING
   * page (formFound:false only; ≥3 links required by the producer, ≤50).
   * The result endpoint classifies + ingests each at child depth.
   */
  listingLinks?: string[];
  questions: Question[];
  confidence: 'high' | 'medium' | 'low';
  /** Incl. "form is JS-rendered/behind login/not found" when relevant. */
  notes: string;
}

/**
 * One observability step of the investigation agent run (assistant text,
 * tool call, tool result, ...). Mirrors TranscriptStep in @sower/investigate.
 */
export interface TranscriptStep {
  seq: number;
  kind: 'assistant_text' | 'tool_use' | 'tool_result' | 'result' | 'system';
  tool?: string;
  input?: unknown;
  output?: string;
  text?: string;
  ts: number;
}

/**
 * Lifecycle of an investigation run:
 * - 'running': trigger row inserted; the Cloud Run Job is (about to be) started.
 * - 'found': the agent located a real apply URL (see result/foundJobId).
 * - 'not_found': the agent finished without a verified URL.
 * - 'error': the run finished but post-processing failed (see `error`).
 */
export type InvestigationRunStatus =
  | 'running'
  | 'found'
  | 'not_found'
  | 'error';

/**
 * What the investigator Job ran for this task:
 * - 'screenshot': vision + web search over a posted screenshot; `result` is
 *   an InvestigationResult.
 * - 'form': headless-browser form discovery of an UNSUPPORTED job link;
 *   `result` is a DiscoveredForm.
 */
export type InvestigationRunKind = 'screenshot' | 'form';

/**
 * One row per Tier-2 investigation (Cloud Run Job execution) of a parked
 * task — a screenshot investigation or an unsupported-link form discovery
 * (see `kind`). `transcript` is the full observability record of the agent
 * run; `foundJobId` links the real job ingested from the located apply URL
 * (screenshot runs only).
 */
export const investigationRuns = pgTable(
  'investigation_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** The parked task being investigated. */
    taskId: uuid('task_id')
      .notNull()
      .references(() => applicationTasks.id),
    kind: text('kind')
      .$type<InvestigationRunKind>()
      .notNull()
      .default('screenshot'),
    status: text('status')
      .$type<InvestigationRunStatus>()
      .notNull()
      .default('running'),
    result: jsonb('result').$type<InvestigationResult | DiscoveredForm>(),
    /** Full agent transcript — the observability record. */
    transcript: jsonb('transcript').$type<TranscriptStep[]>(),
    /** Real job ingested from result.applyUrl (found runs only). */
    foundJobId: uuid('found_job_id').references(() => jobs.id),
    error: text('error'),
    startedAt: timestamp('started_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  // The result endpoint + task detail page read a task's runs by task_id.
  (table) => [index('investigation_runs_task_id_idx').on(table.taskId)],
);

/**
 * What a resume-editor Cloud Run Job execution did (see resume_runs.kind):
 * - 'sync': repo-wide — compile every developer/resumes/*.tex and refresh the
 *   resumes rows + vault PDFs. Read-only w.r.t. the portfolio repo.
 * - 'agent': a Claude Agent SDK session edited the LaTeX per the user's
 *   natural-language prompt, committed, and pushed.
 * - 'write': the dashboard's manual editor saved a full .tex source; the job
 *   validated (compiled) it and committed it via the GitHub Contents API.
 * - 'fork': copy an existing resume's current source to a new
 *   developer/resumes/<newName>.tex and register the new resume.
 */
export type ResumeRunKind = 'sync' | 'agent' | 'write' | 'fork';

/**
 * Lifecycle of a resume-editor run:
 * - 'running': trigger row inserted; the Cloud Run Job is (about to be)
 *   started.
 * - 'succeeded' / 'failed': the job finished and reported back (see `error`
 *   on failures). Written directly by the job — there is no HTTP callback.
 */
export type ResumeRunStatus = 'running' | 'succeeded' | 'failed';

/**
 * One row per LaTeX resume in the user's private portfolio repo
 * (DIodide/portfolio, submodule developer/resumes). Rows are created and
 * refreshed by the resume-editor job's sync (upsert keyed on `name`), which
 * also compiles the PDF into the vault and registers it as a kind='resume'
 * documents row (via `documentId`, so re-syncs update rather than duplicate).
 */
export const resumes = pgTable('resumes', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** The tex filename stem, e.g. 'swe-2027' — unique so sync can upsert. */
  name: text('name').notNull().unique(),
  /** Portfolio-repo-relative path, e.g. 'developer/resumes/swe-2027.tex'. */
  texPath: text('tex_path').notNull(),
  /** Latest LaTeX source snapshot (what the manual editor loads). */
  texSource: text('tex_source'),
  /** Vault path of the latest compiled PDF (resumes/<name>/<name>.pdf). */
  pdfStoragePath: text('pdf_storage_path'),
  /** The auto-registered kind='resume' documents row for the compiled PDF. */
  documentId: uuid('document_id').references(() => documents.id),
  /** Submodule HEAD the latest snapshot/PDF was built from. */
  lastCommitSha: text('last_commit_sha'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
});

/**
 * One row per resume-editor Cloud Run Job execution (sync / agent / write —
 * see ResumeRunKind). The API inserts the 'running' row and starts the Job
 * with RESUME_RUN_ID; the job itself writes status/transcript/commitSha
 * directly to this row when it finishes (it IS the pipeline — unlike the
 * investigator there is no ingest endpoint to report back through).
 */
export const resumeRuns = pgTable(
  'resume_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** The resume being edited. Null for repo-wide sync runs. */
    resumeId: uuid('resume_id').references(() => resumes.id),
    kind: text('kind').$type<ResumeRunKind>().notNull(),
    /**
     * agent runs: the user's natural-language request. write runs: JSON
     * `{texPath, content}` (the manual editor's save). Null for sync runs.
     */
    prompt: text('prompt'),
    status: text('status')
      .$type<ResumeRunStatus>()
      .notNull()
      .default('running'),
    /** Full agent transcript (agent runs) — the observability record. */
    transcript: jsonb('transcript').$type<TranscriptStep[]>(),
    /** Submodule (or parent) commit the run produced, when it committed. */
    commitSha: text('commit_sha'),
    error: text('error'),
    startedAt: timestamp('started_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  // The dashboard reads a resume's run history by resume_id.
  (table) => [index('resume_runs_resume_id_idx').on(table.resumeId)],
);

/**
 * How a resume_versions row came to be (mirrors the run kinds):
 * - 'agent' / 'write' / 'fork': the corresponding run landed this change.
 * - 'sync': a sync run found repo tex that differs from the last recorded
 *   version (an out-of-band edit), or backfilled a resume's first version.
 */
export type ResumeVersionKind = 'agent' | 'write' | 'sync' | 'fork';

/**
 * Immutable history of a resume: one row per (resume, commit) that changed
 * it. Every successful flow that lands a change records one — sync (when the
 * repo drifted from the last recorded version, plus the zero-versions
 * backfill), write, agent (one per changed resume), fork (the new resume's
 * first version). Writers upsert with ON CONFLICT (resume_id, commit_sha)
 * DO NOTHING so a Cloud Run retry can never duplicate history.
 */
export const resumeVersions = pgTable(
  'resume_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    resumeId: uuid('resume_id')
      .notNull()
      .references(() => resumes.id),
    /** Portfolio-repo commit this version's tex came from. */
    commitSha: text('commit_sha').notNull(),
    /** Full LaTeX source at that commit. */
    texSource: text('tex_source').notNull(),
    /**
     * Vault path of this version's compiled PDF
     * (resumes/<name>/versions/<sha>.pdf). Nullable — a version whose
     * compile failed still records its source.
     */
    pdfStoragePath: text('pdf_storage_path'),
    /** The resume_runs row that produced this version, when one did. */
    runId: uuid('run_id').references(() => resumeRuns.id),
    kind: text('kind').$type<ResumeVersionKind>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // The dashboard lists a resume's history newest-first.
    index('resume_versions_resume_id_created_at_idx').on(
      table.resumeId,
      table.createdAt,
    ),
    // Idempotence key: one version per (resume, commit) — retries and
    // re-syncs at the same commit are ON CONFLICT DO NOTHING no-ops.
    uniqueIndex('resume_versions_resume_id_commit_sha_uq').on(
      table.resumeId,
      table.commitSha,
    ),
  ],
);

/**
 * Public share links for a resume (GET /r/:token — the one API route exempt
 * from x-api-key). The unguessable token IS the auth; disabling a link is the
 * revoke (rows are kept for the view stats). The served PDF is always the
 * resume's CURRENT one, so a link stays fresh across edits.
 */
export const resumeLinks = pgTable(
  'resume_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    resumeId: uuid('resume_id')
      .notNull()
      .references(() => resumes.id),
    /** Human label for the audience, e.g. 'Stripe application'. */
    name: text('name').notNull(),
    /** Unguessable url-safe token (≥32 chars; 192 bits from the API). */
    token: text('token').notNull().unique(),
    enabled: boolean('enabled').notNull().default(true),
    viewCount: integer('view_count').notNull().default(0),
    lastViewedAt: timestamp('last_viewed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  // The dashboard lists a resume's links by resume_id.
  (table) => [index('resume_links_resume_id_idx').on(table.resumeId)],
);

/**
 * Lifecycle of a per-tenant candidate account (Workday etc.):
 * - 'provisioned': credential generated and stored in the vault; no account
 *   exists on the tenant yet.
 * - 'registered': the browser tier created the account on the tenant.
 * - 'verified': the tenant's email verification/OTP completed.
 */
export type AccountStatus = 'provisioned' | 'registered' | 'verified';

export const accounts = pgTable(
  'accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    platform: text('platform').notNull(),
    tenant: text('tenant').notNull(),
    /**
     * Career-site path segment (e.g. 'External_Careers') captured at
     * provisioning so the browser tier can reach the sign-in page without
     * re-deriving it from a job URL.
     */
    site: text('site'),
    /** The account's email address (the application email must match it). */
    emailAlias: text('email_alias'),
    /**
     * Vault storage key of the credential JSON (password NEVER lives in the
     * DB) — see credentialStoragePath in @sower/accounts.
     */
    secretRef: text('secret_ref'),
    status: text('status')
      .$type<AccountStatus>()
      .notNull()
      .default('provisioned'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
  },
  (table) => [
    // One candidate account per (platform, tenant): a concurrent double
    // provision cannot create two accounts for the same tenant.
    uniqueIndex('accounts_platform_tenant_uq').on(table.platform, table.tenant),
  ],
);

/**
 * Lifecycle of a per-tenant Workday browser session (the headful capture is the
 * one local, human-in-the-loop step Workday needs):
 * - 'requested': the dashboard asked for a session; waiting for the local agent.
 * - 'capturing': the agent claimed it and opened a headful browser.
 * - 'active': a session was captured, verified from the home IP, and vaulted at
 *   accounts/workday/{tenant}/session.json.
 * - 'failed': the capture verify failed / timed out (see `error`).
 */
export type WorkdaySessionStatus =
  | 'requested'
  | 'capturing'
  | 'active'
  | 'failed';

/**
 * Per-tenant Workday session state + the dashboard→agent request signal. The
 * session cookies themselves live ONLY in the vault; this table is the
 * DB-visible mirror the dashboard reads to show status and the agent claims work
 * from. One row per tenant (upserted).
 */
export const workdaySessions = pgTable('workday_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenant: text('tenant').notNull().unique(),
  host: text('host').notNull(),
  /** Careers/login URL the agent opens for the headful capture. */
  loginUrl: text('login_url').notNull(),
  status: text('status').$type<WorkdaySessionStatus>().notNull(),
  requestedAt: timestamp('requested_at', { withTimezone: true }).defaultNow(),
  capturedAt: timestamp('captured_at', { withTimezone: true }),
  /** Conservative freshness horizon (~20 min) for the UI + re-capture prompts. */
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  /** Populated on a failed capture. */
  error: text('error'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
});

/**
 * Liveness heartbeat for the always-on local capture agent(s). The agent pings
 * periodically so the dashboard can show "agent last seen" — a dead daemon is
 * then visible instead of silently never servicing a Start click. One row per
 * named agent (upserted).
 */
export const agentHeartbeats = pgTable('agent_heartbeats', {
  name: text('name').primaryKey(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).defaultNow(),
  /** Free-form status detail (e.g. 'idle', 'capturing caci'). */
  detail: text('detail'),
});

/**
 * Mirror of @sower/answers' `Profile` (z.infer<typeof ProfileSchema>) — the
 * user's answer-resolution profile. Re-declared locally (like
 * InvestigationResult above) because @sower/answers itself depends on
 * @sower/db to read the profiles table (getProfile), so importing the type
 * from @sower/answers here would create a package cycle. Keep in sync with
 * ProfileSchema in packages/answers/src/profile.ts.
 */
export interface ProfileData {
  name: { first: string; last: string };
  email: string;
  phone: string;
  location: { city: string; state: string; country: string };
  links: {
    website?: string;
    github?: string;
    linkedin?: string;
    twitter?: string;
  };
  education: Array<{
    school: string;
    degree: string;
    major: string;
    gpa?: number;
    startDate: string;
    endDate: string;
  }>;
  work: Array<{
    company: string;
    title: string;
    startDate: string;
    endDate?: string;
    description?: string;
  }>;
  authorization: {
    usWorkAuthorized: boolean;
    requiresSponsorship: boolean;
    usCitizen?: boolean;
    usPerson?: boolean;
    hasActiveSecurityClearance?: boolean;
    everEmployedByUSGovernment?: boolean;
  };
  graduation?: { date?: string; year?: number };
  academics?: { satTotal?: number; actComposite?: number; gpaBandLow?: number };
  preferences?: {
    openToRelocation?: boolean;
    howDidYouHear?: string;
    preferredLocations?: string[];
    pronouns?: string;
  };
  custom: Record<string, string>;
}

/**
 * The user's answer-resolution profile, stored as ONE jsonb document (edited
 * via the dashboard's Answers → Profile page, served by the api's
 * GET/PUT /profile). SINGLE-PROFILE-PER-DEPLOYMENT: one row is expected —
 * enforced in code (PUT /profile updates the first row when one exists and
 * inserts otherwise; readers take the newest by updated_at), not by a DB
 * constraint. The DB row is the source of truth; the legacy PROFILE_PATH
 * YAML file is only a dev-time fallback when no row exists (prod never had
 * the gitignored file — the ENOENT attempt-burn this table fixes).
 */
export const profiles = pgTable('profiles', {
  id: uuid('id').primaryKey().defaultRandom(),
  data: jsonb('data').$type<ProfileData>().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});
