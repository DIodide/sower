import { getTableColumns, getTableName, type Table } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import {
  accounts,
  answers,
  apiCalls,
  applicationTasks,
  documents,
  events,
  investigationRuns,
  jobDescriptions,
  jobs,
} from './schema.js';

function sqlColumnNames(table: Table): string[] {
  return Object.values(getTableColumns(table))
    .map((column) => column.name)
    .sort();
}

describe('schema', () => {
  it('defines the jobs table', () => {
    expect(getTableName(jobs)).toBe('jobs');
    expect(sqlColumnNames(jobs)).toEqual([
      'canonical_url',
      'company',
      'created_at',
      'dedupe_key',
      'external_id',
      'id',
      'platform',
      'source',
      'tenant',
      'terms',
      'title',
      'url',
    ]);
    expect(jobs.canonicalUrl.notNull).toBe(true);
    expect(jobs.canonicalUrl.isUnique).toBe(true);
    // Nullable (pre-migration rows await backfill) but unique, so ingest can
    // rely on ON CONFLICT (dedupe_key) DO NOTHING.
    expect(jobs.dedupeKey.notNull).toBe(false);
    expect(jobs.dedupeKey.isUnique).toBe(true);
  });

  it('defines the application_tasks table', () => {
    expect(getTableName(applicationTasks)).toBe('application_tasks');
    expect(sqlColumnNames(applicationTasks)).toEqual([
      'approval_channel_id',
      'approval_message_id',
      'attempt',
      'created_at',
      'id',
      'ingest_channel_id',
      'ingest_message_id',
      'job_id',
      'job_spec',
      'last_error',
      'otp_channel_id',
      'otp_message_id',
      'otp_requested_at',
      'otp_submitted_at',
      'pending_otp',
      'resolution',
      'state',
      'updated_at',
    ]);
    expect(applicationTasks.state.notNull).toBe(true);
    expect(applicationTasks.attempt.notNull).toBe(true);
    // Both nullable: Discord may be disabled or the card post may fail.
    expect(applicationTasks.approvalChannelId.notNull).toBe(false);
    expect(applicationTasks.approvalMessageId.notNull).toBe(false);
    // OTP relay columns are all nullable (only set while awaiting a code).
    expect(applicationTasks.pendingOtp.notNull).toBe(false);
    // Both nullable: only tasks announced in a #ingest reply carry them.
    expect(applicationTasks.ingestChannelId.notNull).toBe(false);
    expect(applicationTasks.ingestMessageId.notNull).toBe(false);
  });

  it('defines the events table', () => {
    expect(getTableName(events)).toBe('events');
    expect(sqlColumnNames(events)).toEqual([
      'created_at',
      'data',
      'from_state',
      'id',
      'task_id',
      'to_state',
      'type',
    ]);
    expect(events.taskId.notNull).toBe(true);
    expect(events.type.notNull).toBe(true);
  });

  it('defines the answers table', () => {
    expect(getTableName(answers)).toBe('answers');
    expect(sqlColumnNames(answers)).toEqual([
      'company',
      'created_at',
      'id',
      'normalized_label',
      'question_label',
      'source',
      'value',
    ]);
    expect(answers.value.notNull).toBe(true);
    // '' = GLOBAL: NOT NULL with a '' default so pre-migration rows (and
    // writers that omit the field) stay global rather than becoming a
    // distinct NULL scope.
    expect(answers.company.notNull).toBe(true);
    expect(answers.company.default).toBe('');
  });

  it('enforces one answer per (company, normalized_label) on answers', () => {
    const config = getTableConfig(answers);
    const unique = config.indexes.find(
      (idx) => idx.config.name === 'answers_company_normalized_label_uq',
    );
    expect(unique).toBeDefined();
    expect(unique?.config.unique).toBe(true);
    expect(
      unique?.config.columns.map((c) => ('name' in c ? c.name : null)),
    ).toEqual(['company', 'normalized_label']);
  });

  it('defines the api_calls table', () => {
    expect(getTableName(apiCalls)).toBe('api_calls');
    expect(sqlColumnNames(apiCalls)).toEqual([
      'created_at',
      'dry_run',
      'duration_ms',
      'id',
      'method',
      'phase',
      'request_body',
      'request_headers',
      'response_body',
      'response_headers',
      'response_status',
      'seq',
      'task_id',
      'url',
    ]);
    expect(apiCalls.taskId.notNull).toBe(true);
    expect(apiCalls.seq.notNull).toBe(true);
    expect(apiCalls.phase.notNull).toBe(true);
    expect(apiCalls.method.notNull).toBe(true);
    expect(apiCalls.url.notNull).toBe(true);
    expect(apiCalls.dryRun.notNull).toBe(true);
    expect(apiCalls.dryRun.default).toBe(false);
  });

  it('references application_tasks and indexes task_id on api_calls', () => {
    const config = getTableConfig(apiCalls);
    const fk = config.foreignKeys[0]?.reference();
    expect(fk?.foreignTable && getTableName(fk.foreignTable)).toBe(
      'application_tasks',
    );
    expect(fk?.columns.map((c) => c.name)).toEqual(['task_id']);
    expect(config.indexes.map((idx) => idx.config.name ?? null)).toContain(
      'api_calls_task_id_idx',
    );
  });

  it('defines the documents table', () => {
    expect(getTableName(documents)).toBe('documents');
    expect(sqlColumnNames(documents)).toEqual([
      'content_type',
      'created_at',
      'filename',
      'id',
      'job_id',
      'kind',
      'size_bytes',
      'storage_path',
    ]);
    expect(documents.kind.notNull).toBe(true);
    expect(documents.filename.notNull).toBe(true);
    expect(documents.storagePath.notNull).toBe(true);
    expect(documents.contentType.notNull).toBe(false);
    expect(documents.sizeBytes.notNull).toBe(false);
    // Nullable: library documents (resume/cover letter) belong to no job.
    expect(documents.jobId.notNull).toBe(false);
  });

  it('references jobs and indexes job_id on documents', () => {
    const config = getTableConfig(documents);
    const fk = config.foreignKeys[0]?.reference();
    expect(fk?.foreignTable && getTableName(fk.foreignTable)).toBe('jobs');
    expect(fk?.columns.map((c) => c.name)).toEqual(['job_id']);
    expect(config.indexes.map((idx) => idx.config.name ?? null)).toContain(
      'documents_job_id_idx',
    );
  });

  it('defines the job_descriptions table', () => {
    expect(getTableName(jobDescriptions)).toBe('job_descriptions');
    expect(sqlColumnNames(jobDescriptions)).toEqual([
      'content',
      'content_hash',
      'fetched_at',
      'id',
      'job_id',
      'version',
    ]);
    expect(jobDescriptions.jobId.notNull).toBe(true);
    expect(jobDescriptions.version.notNull).toBe(true);
    expect(jobDescriptions.content.notNull).toBe(true);
    expect(jobDescriptions.contentHash.notNull).toBe(true);
    // fetched_at is server-defaulted, so it stays nullable at the type level.
    expect(jobDescriptions.fetchedAt.notNull).toBe(false);
  });

  it('references jobs and indexes job_id on job_descriptions', () => {
    const config = getTableConfig(jobDescriptions);
    const fk = config.foreignKeys[0]?.reference();
    expect(fk?.foreignTable && getTableName(fk.foreignTable)).toBe('jobs');
    expect(fk?.columns.map((c) => c.name)).toEqual(['job_id']);
    expect(config.indexes.map((idx) => idx.config.name ?? null)).toContain(
      'job_descriptions_job_id_idx',
    );
  });

  it('defines the accounts table', () => {
    expect(getTableName(accounts)).toBe('accounts');
    expect(sqlColumnNames(accounts)).toEqual([
      'created_at',
      'email_alias',
      'id',
      'platform',
      'secret_ref',
      'site',
      'status',
      'tenant',
      'updated_at',
    ]);
    expect(accounts.platform.notNull).toBe(true);
    expect(accounts.tenant.notNull).toBe(true);
    expect(accounts.status.notNull).toBe(true);
  });

  it('enforces one account per (platform, tenant)', () => {
    const config = getTableConfig(accounts);
    const unique = config.indexes.find(
      (idx) => idx.config.name === 'accounts_platform_tenant_uq',
    );
    expect(unique).toBeDefined();
    expect(unique?.config.unique).toBe(true);
    expect(
      unique?.config.columns.map((c) => ('name' in c ? c.name : null)),
    ).toEqual(['platform', 'tenant']);
  });

  it('defines the investigation_runs table', () => {
    expect(getTableName(investigationRuns)).toBe('investigation_runs');
    expect(sqlColumnNames(investigationRuns)).toEqual([
      'error',
      'finished_at',
      'found_job_id',
      'id',
      'kind',
      'result',
      'started_at',
      'status',
      'task_id',
      'transcript',
    ]);
    expect(investigationRuns.taskId.notNull).toBe(true);
    expect(investigationRuns.status.notNull).toBe(true);
    expect(investigationRuns.status.default).toBe('running');
    // Pre-existing rows are screenshot runs; the default keeps them honest.
    expect(investigationRuns.kind.notNull).toBe(true);
    expect(investigationRuns.kind.default).toBe('screenshot');
    expect(investigationRuns.startedAt.notNull).toBe(true);
    // All set only as a run progresses/finishes.
    expect(investigationRuns.result.notNull).toBe(false);
    expect(investigationRuns.transcript.notNull).toBe(false);
    expect(investigationRuns.foundJobId.notNull).toBe(false);
    expect(investigationRuns.error.notNull).toBe(false);
    expect(investigationRuns.finishedAt.notNull).toBe(false);
  });

  it('references application_tasks + jobs and indexes task_id on investigation_runs', () => {
    const config = getTableConfig(investigationRuns);
    const foreignTables = config.foreignKeys.map((fk) => {
      const ref = fk.reference();
      return {
        table: getTableName(ref.foreignTable),
        columns: ref.columns.map((c) => c.name),
      };
    });
    expect(foreignTables).toEqual(
      expect.arrayContaining([
        { table: 'application_tasks', columns: ['task_id'] },
        { table: 'jobs', columns: ['found_job_id'] },
      ]),
    );
    expect(config.indexes.map((idx) => idx.config.name ?? null)).toContain(
      'investigation_runs_task_id_idx',
    );
  });
});
