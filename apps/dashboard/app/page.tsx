import type { TaskState } from '@sower/core';
import { applicationTasks, jobs } from '@sower/db';
import { and, count, desc, eq, inArray, ne, type SQL } from 'drizzle-orm';
import Link from 'next/link';
import { getDb } from '../lib/db';
import {
  BUCKETS,
  type Bucket,
  isBucket,
  STATE_META,
  stateMeta,
} from '../lib/format';
import { Empty, StateBadge, Timestamp } from '../lib/ui';

export const dynamic = 'force-dynamic';

const TASK_STATES = Object.keys(STATE_META) as TaskState[];

function isTaskState(value: string): value is TaskState {
  return (TASK_STATES as string[]).includes(value);
}

function firstParam(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function filterHref(filters: {
  view?: Bucket | null;
  state?: TaskState | null;
  platform?: string | null;
}): string {
  const qs = new URLSearchParams();
  if (filters.view) qs.set('view', filters.view);
  if (filters.state) qs.set('state', filters.state);
  if (filters.platform) qs.set('platform', filters.platform);
  const s = qs.toString();
  return s ? `/?${s}` : '/';
}

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;

  const rawState = firstParam(params.state);
  const stateFilter = rawState && isTaskState(rawState) ? rawState : null;
  // An exact state implies its bucket, so the matching stat card stays lit.
  const rawView = firstParam(params.view);
  const viewFilter: Bucket | null = stateFilter
    ? stateMeta(stateFilter).bucket
    : rawView && isBucket(rawView)
      ? rawView
      : null;
  const platformFilter = firstParam(params.platform);

  const db = getDb();

  const [platformRows, stateCounts] = await Promise.all([
    db
      .selectDistinct({ platform: jobs.platform })
      .from(jobs)
      .orderBy(jobs.platform),
    db
      .select({ state: applicationTasks.state, n: count() })
      .from(applicationTasks)
      .groupBy(applicationTasks.state),
  ]);
  const platforms = platformRows.map((r) => r.platform);

  const countByState = new Map(
    stateCounts.map((r) => [r.state as string, r.n]),
  );
  const bucketCount = (bucket: Bucket) =>
    BUCKETS[bucket].states.reduce(
      (sum, s) => sum + (countByState.get(s) ?? 0),
      0,
    );
  // Discarded tasks are removed from the queue: they count toward nothing
  // here and are hidden from the default list (an explicit ?state=DISCARDED
  // filter still shows them).
  const totalTasks = stateCounts
    .filter((r) => r.state !== 'DISCARDED')
    .reduce((sum, r) => sum + r.n, 0);

  const conditions: SQL[] = [];
  if (stateFilter) {
    conditions.push(eq(applicationTasks.state, stateFilter));
  } else if (viewFilter) {
    conditions.push(
      inArray(applicationTasks.state, BUCKETS[viewFilter].states),
    );
  } else {
    conditions.push(ne(applicationTasks.state, 'DISCARDED'));
  }
  if (platformFilter) conditions.push(eq(jobs.platform, platformFilter));

  const rows = await db
    .select({
      id: applicationTasks.id,
      state: applicationTasks.state,
      createdAt: applicationTasks.createdAt,
      updatedAt: applicationTasks.updatedAt,
      company: jobs.company,
      title: jobs.title,
      platform: jobs.platform,
      tenant: jobs.tenant,
      source: jobs.source,
    })
    .from(applicationTasks)
    .innerJoin(jobs, eq(applicationTasks.jobId, jobs.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(applicationTasks.updatedAt))
    .limit(200);

  const hasFilters =
    stateFilter !== null || viewFilter !== null || platformFilter !== null;

  return (
    <div>
      <h1 className="page-title">Applications</h1>
      <p className="page-sub">
        Every ingested job becomes a task here. Start with{' '}
        <strong>Needs you</strong> — those are waiting on your answers or
        approval.
      </p>

      {/* ---- bucket overview (also the primary filter) ---- */}
      <div className="stat-grid">
        <Link
          href={filterHref({ platform: platformFilter })}
          className="stat stat--neutral"
          aria-current={!viewFilter && !stateFilter ? 'true' : undefined}
        >
          <div className="stat-n">{totalTasks}</div>
          <div className="stat-label">All tasks</div>
          <div className="stat-sub">everything, newest first</div>
        </Link>
        {(Object.keys(BUCKETS) as Bucket[]).map((bucket) => {
          const def = BUCKETS[bucket];
          const active = viewFilter === bucket && !stateFilter;
          const parts = def.states
            .map((s) => ({ s, n: countByState.get(s) ?? 0 }))
            .filter((p) => p.n > 0)
            .map((p) => `${p.n} ${stateMeta(p.s).label.toLowerCase()}`);
          return (
            <Link
              key={bucket}
              href={filterHref({ view: bucket, platform: platformFilter })}
              className={`stat stat--${def.tone}`}
              aria-current={active ? 'true' : undefined}
            >
              <div className="stat-n">{bucketCount(bucket)}</div>
              <div className="stat-label">{def.label}</div>
              <div className="stat-sub">
                {parts.length > 0 ? parts.join(' · ') : ' '}
              </div>
            </Link>
          );
        })}
      </div>

      {/* ---- exact state, only within the chosen bucket ---- */}
      {viewFilter ? (
        <div className="chip-row">
          <span className="chip-row-label">State</span>
          <Link
            href={filterHref({ view: viewFilter, platform: platformFilter })}
            className="chip"
            aria-current={stateFilter === null ? 'true' : undefined}
          >
            All {BUCKETS[viewFilter].label.toLowerCase()}
          </Link>
          {BUCKETS[viewFilter].states.map((s) => (
            <Link
              key={s}
              href={filterHref({ state: s, platform: platformFilter })}
              className="chip"
              aria-current={stateFilter === s ? 'true' : undefined}
            >
              {stateMeta(s).label}
              <span className="n">{countByState.get(s) ?? 0}</span>
            </Link>
          ))}
        </div>
      ) : null}

      {/* ---- platform filter ---- */}
      {platforms.length > 1 ? (
        <div className="chip-row">
          <span className="chip-row-label">Platform</span>
          <Link
            href={filterHref({ view: viewFilter, state: stateFilter })}
            className="chip"
            aria-current={platformFilter === null ? 'true' : undefined}
          >
            All platforms
          </Link>
          {platforms.map((p) => (
            <Link
              key={p}
              href={filterHref({
                view: viewFilter,
                state: stateFilter,
                platform: p,
              })}
              className="chip"
              aria-current={platformFilter === p ? 'true' : undefined}
            >
              {p}
            </Link>
          ))}
        </div>
      ) : null}

      {/* ---- task list ---- */}
      {rows.length === 0 ? (
        <div className="card" style={{ marginTop: '1rem' }}>
          {hasFilters ? (
            <p className="hint" style={{ margin: 0 }}>
              No tasks match these filters. <Link href="/">Clear filters</Link>
            </p>
          ) : (
            <p className="hint" style={{ margin: 0 }}>
              No application tasks yet. Ingest a job link (or wait for the next
              source poll) and it will show up here.
            </p>
          )}
        </div>
      ) : (
        <div className="table-card" style={{ marginTop: '0.5rem' }}>
          <table>
            <thead>
              <tr>
                <th>Role</th>
                <th>Platform</th>
                <th>Source</th>
                <th>State</th>
                <th>Added</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td>
                    <div className="cell-main">
                      <Link href={`/tasks/${row.id}`}>
                        {row.company ?? row.title ?? row.id.slice(0, 8)}
                      </Link>
                    </div>
                    <div className="cell-sub">
                      {row.company
                        ? (row.title ?? 'untitled role')
                        : row.title
                          ? '(company unknown)'
                          : 'untitled role'}
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
                  <td>
                    <StateBadge state={row.state} />
                  </td>
                  <td style={{ fontSize: '0.8125rem' }}>
                    <Timestamp value={row.createdAt} />
                  </td>
                  <td style={{ fontSize: '0.8125rem' }}>
                    <Timestamp value={row.updatedAt} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {rows.length === 200 ? (
        <Empty>Showing the 200 most recently updated tasks.</Empty>
      ) : null}
    </div>
  );
}
