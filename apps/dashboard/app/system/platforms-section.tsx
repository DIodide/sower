// Platforms section of /system (moved from the old /platforms page):
// overview cards per ATS, each linking to its per-platform drill-down.
import { applicationTasks, jobs } from '@sower/db';
import { count, eq } from 'drizzle-orm';
import Link from 'next/link';
import { getDb } from '../../lib/db';
import { Empty, StateBadge } from '../../lib/ui';

interface PlatformSummary {
  platform: string;
  jobs: number;
  tasks: number;
  states: { state: string; n: number }[];
}

export async function PlatformsSection() {
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

  return (
    <div>
      <p className="hint" style={{ margin: '0 0 1rem' }}>
        Every ATS sower knows how to talk to, with its job and task counts.
      </p>
      {list.length === 0 ? (
        <div className="card">
          <p className="hint" style={{ margin: 0 }}>
            No platforms yet — ingest a job to get started.
          </p>
        </div>
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(17rem, 1fr))',
            gap: '1.25rem',
          }}
        >
          {list.map((summary) => (
            <Link
              key={summary.platform}
              href={`/platforms/${encodeURIComponent(summary.platform)}`}
              className="stat stat--neutral"
              style={{ color: 'var(--ink)' }}
            >
              <div className="row" style={{ alignItems: 'baseline' }}>
                <span
                  className="mono"
                  style={{ fontSize: '1.0625rem', fontWeight: 800 }}
                >
                  {summary.platform}
                </span>
                <span className="hint faint spread num">
                  {summary.jobs} job{summary.jobs === 1 ? '' : 's'} ·{' '}
                  {summary.tasks} task{summary.tasks === 1 ? '' : 's'}
                </span>
              </div>
              {summary.states.length === 0 ? (
                <p className="hint faint" style={{ margin: '0.625rem 0 0' }}>
                  no tasks yet
                </p>
              ) : (
                <div
                  className="row"
                  style={{ marginTop: '0.625rem', gap: '0.375rem' }}
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
                      <span className="hint faint num">{n}</span>
                    </span>
                  ))}
                </div>
              )}
            </Link>
          ))}
        </div>
      )}
      {list.length > 0 ? (
        <Empty>Select a platform for its tenants and field census.</Empty>
      ) : null}
    </div>
  );
}
