import type { JobSpec } from '@sower/core';
import { applicationTasks, jobs } from '@sower/db';
import { and, asc, eq, isNotNull } from 'drizzle-orm';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getDb } from '../../../lib/db';
import { formatDate, relativeTime } from '../../../lib/format';
import {
  cellStyle,
  Empty,
  ExpandableText,
  headStyle,
  linkStyle,
  MONO,
  MUTED,
  SectionHeading,
  StateBadge,
  TableWrap,
} from '../../../lib/ui';

export const dynamic = 'force-dynamic';

const NO_TENANT = '(no tenant)';

interface TenantSummary {
  tenant: string | null;
  jobIds: Set<string>;
  tasks: number;
  latest: Date | null;
}

interface FieldCensus {
  id: string;
  sampleLabel: string;
  type: string;
  present: number;
  required: number;
}

interface FailureSummary {
  error: string;
  count: number;
  latest: Date | null;
}

function later(a: Date | null, b: Date | null): Date | null {
  if (!a) return b;
  if (!b) return a;
  return a.getTime() >= b.getTime() ? a : b;
}

function pct(n: number, total: number): string {
  if (total === 0) return '—';
  return `${Math.round((n / total) * 100)}%`;
}

export default async function PlatformPage({
  params,
}: {
  params: Promise<{ platform: string }>;
}) {
  const { platform: rawPlatform } = await params;
  const platform = decodeURIComponent(rawPlatform);

  const db = getDb();

  const [rows, specRows] = await Promise.all([
    db
      .select({
        jobId: jobs.id,
        tenant: jobs.tenant,
        jobCreatedAt: jobs.createdAt,
        taskId: applicationTasks.id,
        state: applicationTasks.state,
        taskUpdatedAt: applicationTasks.updatedAt,
        lastError: applicationTasks.lastError,
      })
      .from(jobs)
      .leftJoin(applicationTasks, eq(applicationTasks.jobId, jobs.id))
      .where(eq(jobs.platform, platform)),
    db
      .select({
        jobId: applicationTasks.jobId,
        jobSpec: applicationTasks.jobSpec,
      })
      .from(applicationTasks)
      .innerJoin(jobs, eq(applicationTasks.jobId, jobs.id))
      .where(
        and(eq(jobs.platform, platform), isNotNull(applicationTasks.jobSpec)),
      )
      .orderBy(asc(applicationTasks.createdAt)),
  ]);

  if (rows.length === 0) notFound();

  // --- state totals ---------------------------------------------------------
  const stateTotals = new Map<string, number>();
  for (const row of rows) {
    if (row.taskId && row.state) {
      stateTotals.set(row.state, (stateTotals.get(row.state) ?? 0) + 1);
    }
  }
  const stateList = [...stateTotals.entries()].sort((a, b) => b[1] - a[1]);
  const taskTotal = stateList.reduce((sum, [, n]) => sum + n, 0);
  const jobTotal = new Set(rows.map((r) => r.jobId)).size;

  // --- tenants --------------------------------------------------------------
  const tenants = new Map<string, TenantSummary>();
  for (const row of rows) {
    const key = row.tenant ?? NO_TENANT;
    const summary = tenants.get(key) ?? {
      tenant: row.tenant,
      jobIds: new Set<string>(),
      tasks: 0,
      latest: null,
    };
    summary.jobIds.add(row.jobId);
    if (row.taskId) summary.tasks += 1;
    summary.latest = later(
      summary.latest,
      row.taskUpdatedAt ?? row.jobCreatedAt,
    );
    tenants.set(key, summary);
  }
  const tenantList = [...tenants.values()].sort(
    (a, b) => (b.latest?.getTime() ?? 0) - (a.latest?.getTime() ?? 0),
  );

  // --- common fields census over job_specs (one spec per job, latest wins) ---
  const specByJob = new Map<string, JobSpec>();
  for (const row of specRows) {
    if (row.jobSpec) specByJob.set(row.jobId, row.jobSpec);
  }
  const specTotal = specByJob.size;
  const fields = new Map<string, FieldCensus>();
  for (const spec of specByJob.values()) {
    for (const question of spec.questions ?? []) {
      const entry = fields.get(question.id) ?? {
        id: question.id,
        sampleLabel: question.label,
        type: question.type,
        present: 0,
        required: 0,
      };
      entry.present += 1;
      if (question.required) entry.required += 1;
      fields.set(question.id, entry);
    }
  }
  const fieldList = [...fields.values()].sort(
    (a, b) => b.present - a.present || a.id.localeCompare(b.id),
  );

  // --- recent failures (distinct last_error) ---------------------------------
  const failures = new Map<string, FailureSummary>();
  for (const row of rows) {
    if (!row.lastError) continue;
    const entry = failures.get(row.lastError) ?? {
      error: row.lastError,
      count: 0,
      latest: null,
    };
    entry.count += 1;
    entry.latest = later(entry.latest, row.taskUpdatedAt);
    failures.set(row.lastError, entry);
  }
  const failureList = [...failures.values()]
    .sort((a, b) => (b.latest?.getTime() ?? 0) - (a.latest?.getTime() ?? 0))
    .slice(0, 10);

  return (
    <div>
      <h1
        style={{
          fontSize: '1.125rem',
          fontWeight: 600,
          fontFamily: MONO,
          margin: '0 0 0.25rem',
        }}
      >
        {platform}
      </h1>
      <p style={{ color: MUTED, fontSize: '0.875rem', margin: 0 }}>
        {jobTotal} job{jobTotal === 1 ? '' : 's'} · {taskTotal} task
        {taskTotal === 1 ? '' : 's'} · {tenantList.length} tenant
        {tenantList.length === 1 ? '' : 's'}
      </p>

      <SectionHeading>state totals</SectionHeading>
      {stateList.length === 0 ? (
        <Empty>no tasks on this platform yet.</Empty>
      ) : (
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: '0.5rem',
            alignItems: 'center',
          }}
        >
          {stateList.map(([state, n]) => (
            <span
              key={state}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '0.375rem',
              }}
            >
              <StateBadge state={state} />
              <span style={{ color: MUTED, fontSize: '0.8125rem' }}>{n}</span>
            </span>
          ))}
        </div>
      )}

      <SectionHeading>tenants</SectionHeading>
      {tenantList.length === 0 ? (
        <Empty>no tenants recorded for this platform.</Empty>
      ) : (
        <TableWrap>
          <thead>
            <tr>
              <th style={headStyle}>tenant</th>
              <th style={headStyle}>jobs</th>
              <th style={headStyle}>tasks</th>
              <th style={headStyle}>latest activity</th>
            </tr>
          </thead>
          <tbody>
            {tenantList.map((summary) => (
              <tr key={summary.tenant ?? NO_TENANT}>
                <td style={{ ...cellStyle, fontFamily: MONO }}>
                  {summary.tenant ? (
                    <Link
                      href={`/tenants/${encodeURIComponent(platform)}/${encodeURIComponent(summary.tenant)}`}
                      style={linkStyle}
                    >
                      {summary.tenant}
                    </Link>
                  ) : (
                    <span style={{ color: MUTED }}>{NO_TENANT}</span>
                  )}
                </td>
                <td style={cellStyle}>{summary.jobIds.size}</td>
                <td style={cellStyle}>{summary.tasks}</td>
                <td
                  style={{ ...cellStyle, color: MUTED, whiteSpace: 'nowrap' }}
                  title={formatDate(summary.latest)}
                >
                  {relativeTime(summary.latest)}
                </td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      )}

      <SectionHeading>
        common fields{' '}
        <span style={{ textTransform: 'none', letterSpacing: 0 }}>
          (census over {specTotal} stored job spec{specTotal === 1 ? '' : 's'})
        </span>
      </SectionHeading>
      {fieldList.length === 0 ? (
        <Empty>
          no job specs stored yet — fields appear once tasks are processed.
        </Empty>
      ) : (
        <TableWrap>
          <thead>
            <tr>
              <th style={headStyle}>field id</th>
              <th style={headStyle}>sample label</th>
              <th style={headStyle}>type</th>
              <th style={headStyle}>present</th>
              <th style={headStyle}>required</th>
            </tr>
          </thead>
          <tbody>
            {fieldList.map((field) => (
              <tr key={field.id}>
                <td style={{ ...cellStyle, fontFamily: MONO }}>{field.id}</td>
                <td style={cellStyle}>
                  <ExpandableText text={field.sampleLabel} max={80} />
                </td>
                <td style={{ ...cellStyle, fontFamily: MONO, color: MUTED }}>
                  {field.type}
                </td>
                <td
                  style={cellStyle}
                  title={`${field.present}/${specTotal} jobs`}
                >
                  {pct(field.present, specTotal)}
                  <span style={{ color: MUTED, fontSize: '0.75rem' }}>
                    {' '}
                    ({field.present}/{specTotal})
                  </span>
                </td>
                <td
                  style={cellStyle}
                  title={`${field.required}/${specTotal} jobs`}
                >
                  {pct(field.required, specTotal)}
                </td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      )}

      <SectionHeading>recent failures</SectionHeading>
      {failureList.length === 0 ? (
        <Empty>no failures recorded. good sign.</Empty>
      ) : (
        <TableWrap>
          <thead>
            <tr>
              <th style={headStyle}>error</th>
              <th style={headStyle}>tasks</th>
              <th style={headStyle}>last seen</th>
            </tr>
          </thead>
          <tbody>
            {failureList.map((failure) => (
              <tr key={failure.error}>
                <td style={{ ...cellStyle, color: '#f87171' }}>
                  <ExpandableText text={failure.error} max={140} />
                </td>
                <td style={cellStyle}>{failure.count}</td>
                <td
                  style={{ ...cellStyle, color: MUTED, whiteSpace: 'nowrap' }}
                  title={formatDate(failure.latest)}
                >
                  {relativeTime(failure.latest)}
                </td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      )}
    </div>
  );
}
