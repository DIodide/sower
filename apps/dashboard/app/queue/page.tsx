import type { JobSpec, TaskState } from '@sower/core';
import {
  applicationTasks,
  type InvestigationRunKind,
  type InvestigationRunStatus,
  investigationRuns,
  jobs,
} from '@sower/db';
import { desc, eq, inArray } from 'drizzle-orm';
import Link from 'next/link';
import { getDb } from '../../lib/db';
import { Empty, SectionHeading, StateBadge, Timestamp } from '../../lib/ui';
import { discardTask, investigateTask } from '../tasks/[id]/actions';
import { discardTasks } from './actions';
import { RowActionButton } from './row-action-button';

export const dynamic = 'force-dynamic';

/**
 * Every state the queue stages (pipeline order). DISCARDED tasks left the
 * queue; SUBMITTED/CONFIRMED are finished work and DUPLICATE is parked — none
 * of those are queue members, so they are never loaded here.
 */
const QUEUE_STATES: TaskState[] = [
  'INGESTED',
  'PARSED',
  'QUEUED',
  'PREPARING',
  'NEEDS_INPUT',
  'REVIEW',
  'AWAITING_OTP',
  'FILLING',
  'FAILED',
];

const INCOMING_STATES: readonly TaskState[] = [
  'INGESTED',
  'PARSED',
  'QUEUED',
  'PREPARING',
];
const REVIEW_STATES: readonly TaskState[] = [
  'REVIEW',
  'AWAITING_OTP',
  'FILLING',
];

/** The latest investigation run's shape the queue consults. */
interface LatestRun {
  kind: InvestigationRunKind;
  status: InvestigationRunStatus;
}

interface QueueRow {
  id: string;
  state: TaskState;
  createdAt: Date | null;
  jobSpec: JobSpec | null;
  title: string | null;
  company: string | null;
  platform: string;
  tenant: string | null;
  source: string;
  url: string;
  run?: LatestRun;
}

/** Scheme + www. stripped, capped — the label of last resort. */
function shortenUrl(url: string, max = 60): string {
  const stripped = url.replace(/^https?:\/\//, '').replace(/^www\./, '');
  if (stripped.length <= max) return stripped;
  return `${stripped.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Row label: `Title · Company` (jobs row first, then the discovered spec),
 * the lone known part, or the shortened job URL — NEVER the bare task id.
 * Mirrors the #ingest reply's taskLabel conventions.
 */
function rowLabel(row: QueueRow): string {
  const title = row.title || row.jobSpec?.title || '';
  const company = row.company || row.jobSpec?.company || '';
  if (title && company) return `${title} · ${company}`;
  if (title || company) return title || company;
  return shortenUrl(row.url);
}

/**
 * Form-discovery status of an unsupported row: none / agent running /
 * form discovered (or verified) / no form found. discoveredByAgent on the
 * task's spec is authoritative for "discovered"; the latest run covers the
 * in-flight and no-result cases.
 */
function investigationStatus(row: QueueRow): {
  label: string;
  tone: 'progress' | 'attention' | 'success' | 'danger' | null;
  running: boolean;
} {
  if (row.run?.status === 'running') {
    return { label: 'agent running…', tone: 'progress', running: true };
  }
  if (row.jobSpec?.discoveredByAgent) {
    return row.jobSpec.formVerified
      ? { label: 'form verified', tone: 'success', running: false }
      : { label: 'form discovered', tone: 'attention', running: false };
  }
  if (row.run?.status === 'not_found') {
    return { label: 'no form found', tone: null, running: false };
  }
  if (row.run?.status === 'error') {
    return { label: 'agent error', tone: 'danger', running: false };
  }
  return { label: 'none', tone: null, running: false };
}

/** One staged section: heading + count, a table of rows, or a "none" line. */
function Section({
  title,
  hint,
  rows,
  showInvestigation = false,
}: {
  title: string;
  hint: string;
  rows: QueueRow[];
  showInvestigation?: boolean;
}) {
  return (
    <section>
      <SectionHeading count={rows.length}>{title}</SectionHeading>
      {rows.length === 0 ? (
        <Empty>none</Empty>
      ) : (
        <>
          <p className="hint faint" style={{ margin: '0 0 0.5rem' }}>
            {hint}
          </p>
          <div className="table-card">
            <table>
              <thead>
                <tr>
                  <th aria-label="Select" style={{ width: '2rem' }} />
                  <th>Role</th>
                  <th>Platform</th>
                  <th>Source</th>
                  <th>Added</th>
                  <th>State</th>
                  {showInvestigation ? <th>Investigation</th> : null}
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const label = rowLabel(row);
                  const status = showInvestigation
                    ? investigationStatus(row)
                    : null;
                  return (
                    <tr key={row.id}>
                      <td>
                        <input
                          type="checkbox"
                          name="taskIds"
                          value={row.id}
                          aria-label={`Select ${label}`}
                        />
                      </td>
                      <td>
                        <div className="cell-main">
                          <Link href={`/tasks/${row.id}`}>{label}</Link>
                        </div>
                      </td>
                      <td className="mono" style={{ fontSize: '0.8125rem' }}>
                        {row.platform}
                        {row.tenant ? (
                          <span className="faint"> / {row.tenant}</span>
                        ) : null}
                      </td>
                      <td
                        className="mono faint"
                        style={{ fontSize: '0.8125rem', whiteSpace: 'nowrap' }}
                        title="How this job arrived"
                      >
                        {row.source}
                      </td>
                      <td style={{ fontSize: '0.8125rem' }}>
                        <Timestamp value={row.createdAt} />
                      </td>
                      <td>
                        <StateBadge state={row.state} />
                      </td>
                      {status ? (
                        <td>
                          {status.tone ? (
                            <span className={`badge badge--${status.tone}`}>
                              {status.label}
                            </span>
                          ) : (
                            <span className="hint faint">{status.label}</span>
                          )}
                        </td>
                      ) : null}
                      <td>
                        <div
                          className="row"
                          style={{ gap: '0.375rem', flexWrap: 'wrap' }}
                        >
                          <RowActionButton
                            action={discardTask.bind(null, row.id)}
                            label="Discard"
                            className="btn btn--danger btn--sm"
                            title="Remove this task from the queue (the record is kept)"
                          />
                          {status && !status.running ? (
                            <RowActionButton
                              action={investigateTask.bind(null, row.id)}
                              label="Run browser agent"
                              className="btn btn--primary btn--sm"
                              title="Start the form-discovery browser agent on this job's page"
                            />
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}

export default async function QueuePage() {
  const db = getDb();

  const taskRows = await db
    .select({
      id: applicationTasks.id,
      state: applicationTasks.state,
      createdAt: applicationTasks.createdAt,
      jobSpec: applicationTasks.jobSpec,
      title: jobs.title,
      company: jobs.company,
      platform: jobs.platform,
      tenant: jobs.tenant,
      source: jobs.source,
      url: jobs.url,
    })
    .from(applicationTasks)
    .innerJoin(jobs, eq(applicationTasks.jobId, jobs.id))
    .where(inArray(applicationTasks.state, QUEUE_STATES))
    .orderBy(desc(applicationTasks.createdAt));

  // Latest investigation run per task (newest-first, first one wins) —
  // drives the Unsupported section's status column.
  const latestRuns = new Map<string, LatestRun>();
  if (taskRows.length > 0) {
    const runRows = await db
      .select({
        taskId: investigationRuns.taskId,
        kind: investigationRuns.kind,
        status: investigationRuns.status,
      })
      .from(investigationRuns)
      .where(
        inArray(
          investigationRuns.taskId,
          taskRows.map((row) => row.id),
        ),
      )
      .orderBy(desc(investigationRuns.startedAt));
    for (const run of runRows) {
      if (!latestRuns.has(run.taskId)) {
        latestRuns.set(run.taskId, { kind: run.kind, status: run.status });
      }
    }
  }

  const rows: QueueRow[] = taskRows.map((row) => ({
    ...row,
    run: latestRuns.get(row.id),
  }));

  // ---- staged sections, in pipeline order ----
  const incoming = rows.filter((r) => INCOMING_STATES.includes(r.state));
  const unsupported = rows.filter(
    (r) => r.state === 'NEEDS_INPUT' && r.platform === 'unknown',
  );
  const needsInput = rows.filter(
    (r) => r.state === 'NEEDS_INPUT' && r.platform !== 'unknown',
  );
  const review = rows.filter((r) => REVIEW_STATES.includes(r.state));
  const failed = rows.filter((r) => r.state === 'FAILED');

  return (
    <div>
      <h1 className="page-title">Queue</h1>
      <p className="page-sub">
        The ingestion queue, staged by what happens next. Tick rows and discard
        them in one go, or discard per row — a discarded task leaves the queue
        but keeps its record and history.
      </p>

      <form action={discardTasks}>
        <div className="row" style={{ margin: '0 0 0.75rem' }}>
          <button
            type="submit"
            className="btn btn--danger"
            title="Discards every ticked task below — they leave the queue (records are kept); already-sent applications are refused"
          >
            Discard selected
          </button>
          <span className="hint faint">
            applies to every ticked checkbox, across all sections
          </span>
        </div>

        <Section
          title="Incoming"
          hint="Transient states — the pipeline is still parsing, queuing, or processing these."
          rows={incoming}
        />
        <Section
          title="Unsupported — needs triage"
          hint="Potentially jobs, but on no supported platform. Run the browser agent to discover the application form, or discard."
          rows={unsupported}
          showInvestigation
        />
        <Section
          title="Needs input"
          hint="Supported platform, but questions are missing your answers — open the task to fill them in."
          rows={needsInput}
        />
        <Section
          title="Review"
          hint="Filling or waiting on your review/OTP — open the task to approve or enter the code."
          rows={review}
        />
        <Section
          title="Failed"
          hint="Processing gave up — open the task to see the error and requeue, or discard."
          rows={failed}
        />
      </form>
    </div>
  );
}
