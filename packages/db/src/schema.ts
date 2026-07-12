import type { JobSpec, ResolutionResult, TaskState } from '@sower/core';
import {
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
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
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
});

export const events = pgTable('events', {
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
});

export const answers = pgTable('answers', {
  id: uuid('id').primaryKey().defaultRandom(),
  questionLabel: text('question_label').notNull(),
  normalizedLabel: text('normalized_label').notNull(),
  value: jsonb('value').notNull(),
  source: text('source').notNull().default('user'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});

export const accounts = pgTable('accounts', {
  id: uuid('id').primaryKey().defaultRandom(),
  platform: text('platform').notNull(),
  tenant: text('tenant').notNull(),
  emailAlias: text('email_alias'),
  secretRef: text('secret_ref'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
});
