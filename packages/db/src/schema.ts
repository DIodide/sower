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

export const documents = pgTable('documents', {
  id: uuid('id').primaryKey().defaultRandom(),
  kind: text('kind').notNull(),
  filename: text('filename').notNull(),
  storagePath: text('storage_path').notNull(),
  contentType: text('content_type'),
  sizeBytes: integer('size_bytes'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

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

export const accounts = pgTable('accounts', {
  id: uuid('id').primaryKey().defaultRandom(),
  platform: text('platform').notNull(),
  tenant: text('tenant').notNull(),
  emailAlias: text('email_alias'),
  secretRef: text('secret_ref'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});
