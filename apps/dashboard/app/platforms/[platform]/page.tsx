import type { JobSpec } from '@sower/core';
import { applicationTasks, jobs } from '@sower/db';
import { and, asc, eq, isNotNull } from 'drizzle-orm';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getDb } from '../../../lib/db';
import {
  Empty,
  ExpandableText,
  SectionHeading,
  StateBadge,
  TableWrap,
  Timestamp,
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
      <p style={{ margin: '0 0 1rem' }}>
        <Link href="/system#platforms" className="hint">
          ← All platforms
        </Link>
      </p>
      <h1 className="page-title mono">{platform}</h1>
      <p className="page-sub">
        {jobTotal} job{jobTotal === 1 ? '' : 's'} · {taskTotal} task
        {taskTotal === 1 ? '' : 's'} · {tenantList.length} tenant
        {tenantList.length === 1 ? '' : 's'}
      </p>

      <SectionHeading>State totals</SectionHeading>
      {stateList.length === 0 ? (
        <Empty>No tasks on this platform yet.</Empty>
      ) : (
        <div className="row" style={{ gap: '0.5rem' }}>
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
              <span className="hint num">{n}</span>
            </span>
          ))}
        </div>
      )}

      <SectionHeading count={tenantList.length}>Tenants</SectionHeading>
      {tenantList.length === 0 ? (
        <Empty>No tenants recorded for this platform.</Empty>
      ) : (
        <TableWrap>
          <thead>
            <tr>
              <th>Tenant</th>
              <th>Jobs</th>
              <th>Tasks</th>
              <th>Latest activity</th>
            </tr>
          </thead>
          <tbody>
            {tenantList.map((summary) => (
              <tr key={summary.tenant ?? NO_TENANT}>
                <td className="mono">
                  {summary.tenant ? (
                    <Link
                      href={`/tenants/${encodeURIComponent(platform)}/${encodeURIComponent(summary.tenant)}`}
                    >
                      {summary.tenant}
                    </Link>
                  ) : (
                    <span className="faint">{NO_TENANT}</span>
                  )}
                </td>
                <td className="num">{summary.jobIds.size}</td>
                <td className="num">{summary.tasks}</td>
                <td>
                  <Timestamp value={summary.latest} inline />
                </td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      )}

      <SectionHeading>
        Common fields{' '}
        <span className="hint" style={{ fontWeight: 600 }}>
          census over {specTotal} stored job spec{specTotal === 1 ? '' : 's'}
        </span>
      </SectionHeading>
      {fieldList.length === 0 ? (
        <Empty>
          No job specs stored yet — fields appear once tasks are processed.
        </Empty>
      ) : (
        <TableWrap>
          <thead>
            <tr>
              <th>Field id</th>
              <th>Sample label</th>
              <th>Type</th>
              <th>Present</th>
              <th>Required</th>
            </tr>
          </thead>
          <tbody>
            {fieldList.map((field) => (
              <tr key={field.id}>
                <td className="mono">{field.id}</td>
                <td>
                  <ExpandableText text={field.sampleLabel} max={80} />
                </td>
                <td className="mono faint">{field.type}</td>
                <td
                  className="num"
                  title={`${field.present}/${specTotal} jobs`}
                >
                  {pct(field.present, specTotal)}
                  <span className="faint" style={{ fontSize: '0.78rem' }}>
                    {' '}
                    ({field.present}/{specTotal})
                  </span>
                </td>
                <td
                  className="num"
                  title={`${field.required}/${specTotal} jobs`}
                >
                  {pct(field.required, specTotal)}
                </td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      )}

      <SectionHeading>Recent failures</SectionHeading>
      {failureList.length === 0 ? (
        <Empty>No failures recorded. Good sign.</Empty>
      ) : (
        <TableWrap>
          <thead>
            <tr>
              <th>Error</th>
              <th>Tasks</th>
              <th>Last seen</th>
            </tr>
          </thead>
          <tbody>
            {failureList.map((failure) => (
              <tr key={failure.error}>
                <td style={{ color: 'var(--danger-fg)' }}>
                  <ExpandableText text={failure.error} max={140} />
                </td>
                <td className="num">{failure.count}</td>
                <td>
                  <Timestamp value={failure.latest} inline />
                </td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      )}
    </div>
  );
}
