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
  profiles,
  resumeLinks,
  resumeRuns,
  resumes,
  resumeVersions,
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
      'deadline',
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
    // Nullable timestamptz: most postings publish no deadline.
    expect(jobs.deadline.notNull).toBe(false);
    expect(jobs.deadline.columnType).toBe('PgTimestamp');
  });

  it('defines the application_tasks table', () => {
    expect(getTableName(applicationTasks)).toBe('application_tasks');
    expect(sqlColumnNames(applicationTasks)).toEqual([
      'approval_channel_id',
      'approval_message_id',
      'attempt',
      'created_at',
      'due_date',
      'id',
      'ingest_channel_id',
      'ingest_message_id',
      'job_id',
      'job_spec',
      'last_error',
      'notes',
      'otp_channel_id',
      'otp_message_id',
      'otp_requested_at',
      'otp_submitted_at',
      'pending_otp',
      'priority',
      'resolution',
      'sort_rank',
      'state',
      'updated_at',
    ]);
    expect(applicationTasks.state.notNull).toBe(true);
    expect(applicationTasks.attempt.notNull).toBe(true);
    // Freeform user notes: nullable (absent until the user writes one).
    expect(applicationTasks.notes.notNull).toBe(false);
    // Priority is an int (2/1/0/-1) so ORDER BY priority DESC works; NOT NULL
    // with a 0 (normal) default so every pre-existing row sorts as normal.
    expect(applicationTasks.priority.notNull).toBe(true);
    expect(applicationTasks.priority.default).toBe(0);
    // Manual "Waiting on you" position: nullable double precision — unranked
    // rows fall back to the priority sort; midpoints need fractional ranks.
    expect(applicationTasks.sortRank.notNull).toBe(false);
    expect(applicationTasks.sortRank.columnType).toBe('PgDoublePrecision');
    // The user's own due date (distinct from jobs.deadline): nullable
    // timestamptz, absent until the user sets one.
    expect(applicationTasks.dueDate.notNull).toBe(false);
    expect(applicationTasks.dueDate.columnType).toBe('PgTimestamp');
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

  it('defines the resumes table', () => {
    expect(getTableName(resumes)).toBe('resumes');
    expect(sqlColumnNames(resumes)).toEqual([
      'document_id',
      'id',
      'last_commit_sha',
      'name',
      'pdf_storage_path',
      'tex_path',
      'tex_source',
      'updated_at',
    ]);
    // The tex filename stem is the upsert key for sync runs: NOT NULL and
    // unique so a concurrent double-sync cannot create two rows per resume.
    expect(resumes.name.notNull).toBe(true);
    expect(resumes.name.isUnique).toBe(true);
    expect(resumes.texPath.notNull).toBe(true);
    // All nullable: filled in as the first sync compiles/uploads/registers.
    expect(resumes.texSource.notNull).toBe(false);
    expect(resumes.pdfStoragePath.notNull).toBe(false);
    expect(resumes.documentId.notNull).toBe(false);
    expect(resumes.lastCommitSha.notNull).toBe(false);
  });

  it('references documents on resumes', () => {
    const config = getTableConfig(resumes);
    const fk = config.foreignKeys[0]?.reference();
    expect(fk?.foreignTable && getTableName(fk.foreignTable)).toBe('documents');
    expect(fk?.columns.map((c) => c.name)).toEqual(['document_id']);
  });

  it('defines the resume_runs table', () => {
    expect(getTableName(resumeRuns)).toBe('resume_runs');
    expect(sqlColumnNames(resumeRuns)).toEqual([
      'commit_sha',
      'error',
      'finished_at',
      'id',
      'kind',
      'prompt',
      'resume_id',
      'started_at',
      'status',
      'transcript',
    ]);
    // Nullable: sync runs are repo-wide, not tied to a single resume.
    expect(resumeRuns.resumeId.notNull).toBe(false);
    expect(resumeRuns.kind.notNull).toBe(true);
    expect(resumeRuns.status.notNull).toBe(true);
    expect(resumeRuns.status.default).toBe('running');
    expect(resumeRuns.startedAt.notNull).toBe(true);
    // All set only as a run progresses/finishes.
    expect(resumeRuns.prompt.notNull).toBe(false);
    expect(resumeRuns.transcript.notNull).toBe(false);
    expect(resumeRuns.commitSha.notNull).toBe(false);
    expect(resumeRuns.error.notNull).toBe(false);
    expect(resumeRuns.finishedAt.notNull).toBe(false);
  });

  it('references resumes and indexes resume_id on resume_runs', () => {
    const config = getTableConfig(resumeRuns);
    const fk = config.foreignKeys[0]?.reference();
    expect(fk?.foreignTable && getTableName(fk.foreignTable)).toBe('resumes');
    expect(fk?.columns.map((c) => c.name)).toEqual(['resume_id']);
    expect(config.indexes.map((idx) => idx.config.name ?? null)).toContain(
      'resume_runs_resume_id_idx',
    );
  });

  it('defines the resume_versions table', () => {
    expect(getTableName(resumeVersions)).toBe('resume_versions');
    expect(sqlColumnNames(resumeVersions)).toEqual([
      'commit_sha',
      'created_at',
      'id',
      'kind',
      'pdf_storage_path',
      'resume_id',
      'run_id',
      'tex_source',
    ]);
    expect(resumeVersions.resumeId.notNull).toBe(true);
    expect(resumeVersions.commitSha.notNull).toBe(true);
    expect(resumeVersions.texSource.notNull).toBe(true);
    expect(resumeVersions.kind.notNull).toBe(true);
    expect(resumeVersions.createdAt.notNull).toBe(true);
    // Nullable: a version whose compile failed still records its source.
    expect(resumeVersions.pdfStoragePath.notNull).toBe(false);
    // Nullable: sync-detected drift has no producing run to point at.
    expect(resumeVersions.runId.notNull).toBe(false);
  });

  it('references resumes + resume_runs and keys versions on (resume_id, commit_sha)', () => {
    const config = getTableConfig(resumeVersions);
    const foreignTables = config.foreignKeys.map((fk) => {
      const ref = fk.reference();
      return {
        table: getTableName(ref.foreignTable),
        columns: ref.columns.map((c) => c.name),
      };
    });
    expect(foreignTables).toEqual(
      expect.arrayContaining([
        { table: 'resumes', columns: ['resume_id'] },
        { table: 'resume_runs', columns: ['run_id'] },
      ]),
    );
    // History reads: (resume_id, created_at) newest-first.
    expect(config.indexes.map((idx) => idx.config.name ?? null)).toContain(
      'resume_versions_resume_id_created_at_idx',
    );
    // Idempotence: ON CONFLICT (resume_id, commit_sha) DO NOTHING relies on
    // this unique index — a retry can never duplicate history.
    const unique = config.indexes.find(
      (idx) => idx.config.name === 'resume_versions_resume_id_commit_sha_uq',
    );
    expect(unique).toBeDefined();
    expect(unique?.config.unique).toBe(true);
    expect(
      unique?.config.columns.map((c) => ('name' in c ? c.name : null)),
    ).toEqual(['resume_id', 'commit_sha']);
  });

  it('defines the resume_links table', () => {
    expect(getTableName(resumeLinks)).toBe('resume_links');
    expect(sqlColumnNames(resumeLinks)).toEqual([
      'created_at',
      'enabled',
      'id',
      'last_viewed_at',
      'name',
      'resume_id',
      'token',
      'view_count',
    ]);
    expect(resumeLinks.resumeId.notNull).toBe(true);
    expect(resumeLinks.name.notNull).toBe(true);
    // The token IS the auth for the public route: NOT NULL and unique so a
    // lookup resolves at most one link.
    expect(resumeLinks.token.notNull).toBe(true);
    expect(resumeLinks.token.isUnique).toBe(true);
    // enabled=false is the revoke; links start enabled.
    expect(resumeLinks.enabled.notNull).toBe(true);
    expect(resumeLinks.enabled.default).toBe(true);
    expect(resumeLinks.viewCount.notNull).toBe(true);
    expect(resumeLinks.viewCount.default).toBe(0);
    // Nullable until the first public view.
    expect(resumeLinks.lastViewedAt.notNull).toBe(false);
    expect(resumeLinks.createdAt.notNull).toBe(true);
  });

  it('references resumes and indexes resume_id on resume_links', () => {
    const config = getTableConfig(resumeLinks);
    const fk = config.foreignKeys[0]?.reference();
    expect(fk?.foreignTable && getTableName(fk.foreignTable)).toBe('resumes');
    expect(fk?.columns.map((c) => c.name)).toEqual(['resume_id']);
    expect(config.indexes.map((idx) => idx.config.name ?? null)).toContain(
      'resume_links_resume_id_idx',
    );
  });

  it('defines the profiles table', () => {
    expect(getTableName(profiles)).toBe('profiles');
    expect(sqlColumnNames(profiles)).toEqual(['data', 'id', 'updated_at']);
    // The whole profile is one jsonb document — NOT NULL: a row without a
    // profile is meaningless (absence is modeled as NO row, and readers fall
    // back to the empty profile in code).
    expect(profiles.data.notNull).toBe(true);
    expect(profiles.data.columnType).toBe('PgJsonb');
    // updated_at drives "newest row wins" reads; NOT NULL with a now()
    // default so every write is orderable.
    expect(profiles.updatedAt.notNull).toBe(true);
    expect(profiles.updatedAt.columnType).toBe('PgTimestamp');
  });

  it('keeps profiles single-row by convention, not constraint', () => {
    // SINGLE-PROFILE-PER-DEPLOYMENT is enforced in code (PUT /profile
    // upserts the first row): no unique index or FK exists to fight future
    // multi-profile support.
    const config = getTableConfig(profiles);
    expect(config.indexes).toHaveLength(0);
    expect(config.foreignKeys).toHaveLength(0);
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
