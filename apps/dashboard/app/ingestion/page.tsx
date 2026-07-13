import { ingestionRuns, jobs } from '@sower/db';
import { count, desc } from 'drizzle-orm';
import { getDb } from '../../lib/db';
import { relativeTime } from '../../lib/format';
import { Empty } from '../../lib/ui';

export const dynamic = 'force-dynamic';

/** One funnel stat card (mirrors the home page's .stat cards). */
function StatCard({
  n,
  label,
  sub,
  tone = 'neutral',
}: {
  n: number;
  label: string;
  sub: string;
  tone?: 'neutral' | 'success' | 'attention';
}) {
  return (
    <div className={`stat stat--${tone}`}>
      <div className="stat-n num">{n}</div>
      <div className="stat-label">{label}</div>
      <div className="stat-sub">{sub}</div>
    </div>
  );
}

export default async function IngestionPage() {
  const db = getDb();

  const [runs, jobsBySource, totalJobsRows] = await Promise.all([
    db
      .select()
      .from(ingestionRuns)
      .orderBy(desc(ingestionRuns.createdAt))
      .limit(20),
    db
      .select({ source: jobs.source, n: count() })
      .from(jobs)
      .groupBy(jobs.source),
    db.select({ n: count() }).from(jobs),
  ]);

  const latest = runs[0];
  const totalJobs = totalJobsRows[0]?.n ?? 0;

  // Merge the sources the latest run polled with the sources that have actually
  // produced jobs (jobs.source), so both "polling but nothing yet" and legacy /
  // manual sources show up.
  const jobsBySourceMap = new Map(jobsBySource.map((r) => [r.source, r.n]));
  const polledSources = latest?.sources ?? [];
  const sourceRows = [
    ...new Set<string>([...polledSources, ...jobsBySourceMap.keys()]),
  ]
    .map((name) => ({
      name,
      jobs: jobsBySourceMap.get(name) ?? 0,
      polling: polledSources.includes(name),
    }))
    .sort((a, b) => b.jobs - a.jobs || a.name.localeCompare(b.name));

  return (
    <div>
      <h1 className="page-title">Ingestion</h1>
      <p className="page-sub">
        Hourly polls of the Summer 2027 listing source(s): the funnel from
        scanned listings to auto-ingested tasks, deduped by
        platform:tenant:externalId. {totalJobs} job
        {totalJobs === 1 ? '' : 's'} ingested in all.
      </p>

      {latest ? (
        <>
          <div className="stat-grid">
            <StatCard
              n={latest.scanned}
              label="Scanned"
              sub="matched the term filter"
            />
            <StatCard
              n={latest.matched}
              label="Auto-ingestable"
              sub="supported platform + tenant"
            />
            <StatCard
              n={latest.ingested}
              label="Ingested"
              sub="new this run"
              tone="success"
            />
            <StatCard
              n={latest.duplicates}
              label="Duplicates"
              sub="already known (deduped)"
            />
            <StatCard
              n={latest.skipped}
              label="Skipped"
              sub="no adapter / no tenant"
              tone="attention"
            />
          </div>

          <div className="card" style={{ marginTop: '1rem' }}>
            <div className="row" style={{ alignItems: 'baseline' }}>
              <strong>Latest run</strong>
              <span className="hint faint spread">
                {relativeTime(latest.createdAt)} · {latest.durationMs} ms ·{' '}
                {latest.ok ? 'ok' : 'FAILED'}
              </span>
            </div>
            {!latest.ok && latest.error ? (
              <p className="hint" style={{ color: 'var(--danger)', margin: 0 }}>
                {latest.error}
              </p>
            ) : null}
            {Object.keys(latest.byPlatform).length > 0 ? (
              <div
                className="row"
                style={{
                  marginTop: '0.625rem',
                  gap: '0.375rem',
                  flexWrap: 'wrap',
                }}
              >
                {Object.entries(latest.byPlatform)
                  .sort((a, b) => b[1] - a[1])
                  .map(([platform, n]) => (
                    <span key={platform} className="chip">
                      <span className="mono">{platform}</span>{' '}
                      <span className="num faint">{n}</span>
                    </span>
                  ))}
              </div>
            ) : null}
          </div>
        </>
      ) : (
        <div className="card">
          <p className="hint" style={{ margin: 0 }}>
            No ingestion runs yet — the hourly poll records one each run.
            Trigger one with{' '}
            <code className="mono">POST /sources/simplify/poll</code>.
          </p>
        </div>
      )}

      {/* ---- Sources ---- */}
      <h2 className="section-title" style={{ margin: '1.5rem 0 0.25rem' }}>
        Sources
      </h2>
      {sourceRows.length === 0 ? (
        <Empty>No sources have produced jobs yet.</Empty>
      ) : (
        <div className="table-card">
          <table>
            <thead>
              <tr>
                <th>Source</th>
                <th>Jobs</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {sourceRows.map((s) => (
                <tr key={s.name}>
                  <td className="mono">{s.name}</td>
                  <td className="num">{s.jobs}</td>
                  <td>
                    {s.polling ? (
                      <span className="badge badge--success">
                        polling hourly
                      </span>
                    ) : (
                      <span className="hint faint">inactive</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ---- Recent runs ---- */}
      <h2 className="section-title" style={{ margin: '1.5rem 0 0.25rem' }}>
        Recent runs
      </h2>
      {runs.length === 0 ? (
        <Empty>Runs will appear here after the first poll.</Empty>
      ) : (
        <div className="table-card">
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Scanned</th>
                <th>Matched</th>
                <th>Ingested</th>
                <th>Dupes</th>
                <th>Skipped</th>
                <th>Took</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr key={run.id}>
                  <td title={run.createdAt?.toISOString?.() ?? ''}>
                    {relativeTime(run.createdAt)}
                  </td>
                  <td className="num">{run.scanned}</td>
                  <td className="num">{run.matched}</td>
                  <td className="num">{run.ingested}</td>
                  <td className="num faint">{run.duplicates}</td>
                  <td className="num faint">{run.skipped}</td>
                  <td className="num faint">{run.durationMs} ms</td>
                  <td>
                    <span
                      className={`badge badge--${run.ok ? 'success' : 'danger'}`}
                    >
                      {run.ok ? 'ok' : 'failed'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
