import { getTableColumns, getTableName, type Table } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { accounts, answers, applicationTasks, events, jobs } from './schema.js';

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
  });

  it('defines the application_tasks table', () => {
    expect(getTableName(applicationTasks)).toBe('application_tasks');
    expect(sqlColumnNames(applicationTasks)).toEqual([
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
