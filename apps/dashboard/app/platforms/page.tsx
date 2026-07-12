import { applicationTasks, jobs } from '@sower/db';
import { count, eq } from 'drizzle-orm';
import Link from 'next/link';
import { getDb } from '../../lib/db';
import {
  cellStyle,
  Empty,
  headStyle,
  linkStyle,
  MONO,
  MUTED,
  StateBadge,
  TableWrap,
} from '../../lib/ui';

export const dynamic = 'force-dynamic';

interface PlatformSummary {
  platform: string;
  jobs: number;
  tasks: number;
  states: { state: string; n: number }[];
}

export default async function PlatformsPage() {
  const db = getDb();

  const [jobCounts, taskCounts] = await Promise.all([
    db
      .select({ platform: jobs.platform, n: count() })
      .from(jobs)
      .groupBy(jobs.platform),
    db
      .select({
        platform: jobs.platform,
        state: applicationTasks.state,
        n: count(),
      })
      .from(applicationTasks)
      .innerJoin(jobs, eq(applicationTasks.jobId, jobs.id))
      .groupBy(jobs.platform, applicationTasks.state),
  ]);

  const summaries = new Map<string, PlatformSummary>();
  for (const row of jobCounts) {
    summaries.set(row.platform, {
      platform: row.platform,
      jobs: row.n,
      tasks: 0,
      states: [],
    });
  }
  for (const row of taskCounts) {
    const summary = summaries.get(row.platform) ?? {
      platform: row.platform,
      jobs: 0,
      tasks: 0,
      states: [],
    };
    summary.tasks += row.n;
    summary.states.push({ state: row.state, n: row.n });
    summaries.set(row.platform, summary);
  }
  const list = [...summaries.values()].sort((a, b) =>
    a.platform.localeCompare(b.platform),
  );
  for (const summary of list) {
    summary.states.sort((a, b) => b.n - a.n);
  }

  if (list.length === 0) {
    return <Empty>no platforms yet — ingest a job to get started.</Empty>;
  }

  return (
    <TableWrap>
      <thead>
        <tr>
          <th style={headStyle}>platform</th>
          <th style={headStyle}>jobs</th>
          <th style={headStyle}>tasks</th>
          <th style={headStyle}>by state</th>
        </tr>
      </thead>
      <tbody>
        {list.map((summary) => (
          <tr key={summary.platform}>
            <td style={{ ...cellStyle, fontFamily: MONO }}>
              <Link
                href={`/platforms/${encodeURIComponent(summary.platform)}`}
                style={linkStyle}
              >
                {summary.platform}
              </Link>
            </td>
            <td style={cellStyle}>{summary.jobs}</td>
            <td style={cellStyle}>{summary.tasks}</td>
            <td style={cellStyle}>
              {summary.states.length === 0 ? (
                <span style={{ color: MUTED }}>no tasks</span>
              ) : (
                <span
                  style={{
                    display: 'inline-flex',
                    flexWrap: 'wrap',
                    gap: '0.375rem',
                    alignItems: 'center',
                  }}
                >
                  {summary.states.map(({ state, n }) => (
                    <span
                      key={state}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '0.25rem',
                      }}
                    >
                      <StateBadge state={state} />
                      <span style={{ color: MUTED, fontSize: '0.75rem' }}>
                        {n}
                      </span>
                    </span>
                  ))}
                </span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </TableWrap>
  );
}
