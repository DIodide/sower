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
      'job_id',
      'job_spec',
      'last_error',
      'resolution',
      'state',
      'updated_at',
    ]);
    expect(applicationTasks.state.notNull).toBe(true);
    expect(applicationTasks.attempt.notNull).toBe(true);
    // Both nullable: Discord may be disabled or the card post may fail.
    expect(applicationTasks.approvalChannelId.notNull).toBe(false);
    expect(applicationTasks.approvalMessageId.notNull).toBe(false);
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
      'created_at',
      'id',
      'normalized_label',
      'question_label',
      'source',
      'value',
    ]);
    expect(answers.value.notNull).toBe(true);
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
      'kind',
      'size_bytes',
      'storage_path',
    ]);
    expect(documents.kind.notNull).toBe(true);
    expect(documents.filename.notNull).toBe(true);
    expect(documents.storagePath.notNull).toBe(true);
    expect(documents.contentType.notNull).toBe(false);
    expect(documents.sizeBytes.notNull).toBe(false);
  });

  it('defines the accounts table', () => {
    expect(getTableName(accounts)).toBe('accounts');
    expect(sqlColumnNames(accounts)).toEqual([
      'created_at',
      'email_alias',
      'id',
      'platform',
      'secret_ref',
      'tenant',
    ]);
    expect(accounts.platform.notNull).toBe(true);
    expect(accounts.tenant.notNull).toBe(true);
  });
});
