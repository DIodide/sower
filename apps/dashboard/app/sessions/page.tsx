import {
  agentHeartbeats,
  applicationTasks,
  jobs,
  type WorkdaySessionRow,
  workdaySessions,
} from '@sower/db';
import { count, desc, eq } from 'drizzle-orm';
import { getDb } from '../../lib/db';
import { Empty, Timestamp } from '../../lib/ui';

export const dynamic = 'force-dynamic';

/** A heartbeat older than this reads as "agent offline". */
const AGENT_STALE_MS = 2 * 60_000;

type Effective = 'active' | 'expired' | 'requested' | 'capturing' | 'failed';

const STATUS_TONE: Record<Effective, string> = {
  active: 'success',
  expired: 'neutral',
  requested: 'attention',
  capturing: 'attention',
  failed: 'danger',
};

function effectiveStatus(row: WorkdaySessionRow, now: number): Effective {
  if (row.status !== 'active') return row.status;
  if (row.expiresAt && row.expiresAt.getTime() < now) return 'expired';
  return 'active';
}

export default async function SessionsPage() {
  const db = getDb();
  const now = Date.now();

  const [sessions, heartbeats, workdayTaskCounts] = await Promise.all([
    db.select().from(workdaySessions).orderBy(desc(workdaySessions.updatedAt)),
    db.select().from(agentHeartbeats).orderBy(desc(agentHeartbeats.lastSeenAt)),
    db
      .select({
        tenant: jobs.tenant,
        state: applicationTasks.state,
        n: count(),
      })
      .from(applicationTasks)
      .innerJoin(jobs, eq(applicationTasks.jobId, jobs.id))
      .where(eq(jobs.platform, 'workday'))
      .groupBy(jobs.tenant, applicationTasks.state),
  ]);

  const totalByTenant = new Map<string, number>();
  const parkedByTenant = new Map<string, number>();
  for (const row of workdayTaskCounts) {
    const tenant = row.tenant ?? '';
    totalByTenant.set(tenant, (totalByTenant.get(tenant) ?? 0) + row.n);
    if (row.state === 'NEEDS_INPUT') {
      parkedByTenant.set(tenant, (parkedByTenant.get(tenant) ?? 0) + row.n);
    }
  }

  return (
    <div>
      <h1 className="page-title">Sessions</h1>
      <p className="page-sub">
        Workday needs a headful, human-in-the-loop browser session per company —
        the one step that runs on your machine. Start a capture from a parked
        Workday task; the local agent opens a browser, you sign in, and every
        job at that company unlocks until the session expires (~20 min).
      </p>

      {/* ---- agent liveness ---- */}
      <div className="card">
        {heartbeats.length === 0 ? (
          <p className="hint" style={{ margin: 0 }}>
            <strong>No capture agent has checked in.</strong> Start it on your
            machine with{' '}
            <code className="mono">pnpm --filter @sower/worker agent</code> — a
            Start click does nothing until the agent is running.
          </p>
        ) : (
          <div className="row" style={{ gap: '1rem', flexWrap: 'wrap' }}>
            {heartbeats.map((hb) => {
              const online =
                hb.lastSeenAt && now - hb.lastSeenAt.getTime() < AGENT_STALE_MS;
              return (
                <span key={hb.name} className="row" style={{ gap: '0.4rem' }}>
                  <span
                    className={`badge badge--${online ? 'success' : 'danger'}`}
                  >
                    {online ? 'agent online' : 'agent offline'}
                  </span>
                  <span className="mono">{hb.name}</span>
                  <span className="hint faint">
                    seen <Timestamp value={hb.lastSeenAt} inline />
                    {hb.detail ? ` · ${hb.detail}` : ''}
                  </span>
                </span>
              );
            })}
          </div>
        )}
      </div>

      {/* ---- per-tenant sessions ---- */}
      <h2 className="section-title" style={{ margin: '1.5rem 0 0.25rem' }}>
        Workday tenants
      </h2>
      {sessions.length === 0 ? (
        <Empty>
          No Workday sessions yet — open a parked Workday task and click “Start
          session capture”.
        </Empty>
      ) : (
        <div className="table-card">
          <table>
            <thead>
              <tr>
                <th>Tenant</th>
                <th>Status</th>
                <th>Captured</th>
                <th>Expires</th>
                <th>Tasks</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => {
                const eff = effectiveStatus(s, now);
                const total = totalByTenant.get(s.tenant) ?? 0;
                const parked = parkedByTenant.get(s.tenant) ?? 0;
                return (
                  <tr key={s.tenant}>
                    <td className="mono">{s.tenant}</td>
                    <td>
                      <span className={`badge badge--${STATUS_TONE[eff]}`}>
                        {eff}
                      </span>
                    </td>
                    <td>
                      <Timestamp value={s.capturedAt} />
                    </td>
                    <td>
                      <Timestamp value={s.expiresAt} />
                    </td>
                    <td className="num">
                      {total}
                      {parked > 0 ? (
                        <span className="hint faint"> · {parked} parked</span>
                      ) : null}
                    </td>
                    <td className="hint faint">
                      {eff === 'failed' && s.error ? s.error : ''}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
