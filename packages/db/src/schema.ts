import type { JobSpec, ResolutionResult, TaskState } from '@sower/core';
import {
  boolean,
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
