import type { TaskState } from '@sower/core';
import {
  applicationTasks,
  type InvestigationRunStatus,
  investigationRuns,
  jobs,
} from '@sower/db';
import {
  and,
  count,
  desc,
  eq,
  ilike,
  inArray,
  or,
  type SQL,
} from 'drizzle-orm';
import Link from 'next/link';
import { getDb } from '../lib/db';
import {
  BUCKETS,
  type Bucket,
  formatLocal,
  isBucket,
  relativeTime,
  rowLabel,
  STATE_META,
  stateMeta,
  type Tone,
} from '../lib/format';
import { Empty, SectionHeading } from '../lib/ui';
import { QuickAddBar } from './quick-add-bar';
import { TaskRow, type TaskRowData } from './task-row';
import { Workspace } from './workspace';

export const dynamic = 'force-dynamic';

const TASK_STATES = Object.keys(STATE_META) as TaskState[];

/** List cap: enough to scan, never the whole history. */
const LIST_CAP = 200;

/** Sent rows shown before the "show all" expander. */
const SENT_VISIBLE = 10;

const WAITING_STATES: readonly TaskState[] = [
  'NEEDS_INPUT',
  'REVIEW',
  'AWAITING_OTP',
];
const PROCESSING_STATES: readonly TaskState[] = [
  'INGESTED',
  'PARSED',
  'QUEUED',
  'PREPARING',
  'FILLING',
];
const SENT_STATES: readonly TaskState[] = ['SUBMITTED', 'CONFIRMED'];
const ARCHIVE_STATES: readonly TaskState[] = [
  'FAILED',
  'DUPLICATE',
  'DISCARDED',
];

function isTaskState(value: string): value is TaskState {
  return (TASK_STATES as string[]).includes(value);
}

function firstParam(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function filterHref(filters: {
  q?: string | null;
  bucket?: Bucket | null;
  state?: TaskState | null;
  platform?: string | null;
}): string {
  const qs = new URLSearchParams();
  if (filters.q) qs.set('q', filters.q);
  if (filters.bucket) qs.set('bucket', filters.bucket);
  if (filters.state) qs.set('state', filters.state);
  if (filters.platform) qs.set('platform', filters.platform);
  const s = qs.toString();
  return s ? `/?${s}` : '/';
}

/**
 * Form-discovery status of an unsupported row: none / agent running /
 * form discovered (or verified) / no form found. discoveredByAgent on the
 * task's spec is authoritative for "discovered"; the latest run covers the
 * in-flight and no-result cases. (Moved from the old Queue page.)
 */
function investigationStatus(
  run: { status: InvestigationRunStatus } | undefined,
  jobSpec: { discoveredByAgent?: boolean; formVerified?: boolean } | null,
): { label: string; tone: Tone | null; running: boolean } {
  if (run?.status === 'running') {
    return { label: 'agent running…', tone: 'progress', running: true };
  }
  if (jobSpec?.discoveredByAgent) {
    return jobSpec.formVerified
      ? { label: 'form verified', tone: 'success', running: false }
      : { label: 'form discovered', tone: 'attention', running: false };
  }
  if (run?.status === 'not_found') {
    return { label: 'no form found', tone: null, running: false };
  }
  if (run?.status === 'error') {
    return { label: 'agent error', tone: 'danger', running: false };
  }
  return { label: 'not investigated yet', tone: null, running: false };
}

function RowList({ rows }: { rows: TaskRowData[] }) {
  return (
    <div className="row-list">
      {rows.map((row) => (
        <TaskRow key={row.id} row={row} />
      ))}
    </div>
  );
}

/** One section: heading + grid rows, or a one-line "none". */
function Section({ title, rows }: { title: string; rows: TaskRowData[] }) {
  return (
    <section>
      <SectionHeading count={rows.length}>{title}</SectionHeading>
      {rows.length === 0 ? <Empty>none</Empty> : <RowList rows={rows} />}
    </section>
  );
}

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;

  const qFilter = firstParam(params.q)?.trim() || null;
  const rawState = firstParam(params.state);
  const stateFilter = rawState && isTaskState(rawState) ? rawState : null;
  // An exact state implies its bucket, so the matching chip stays lit
  // (archive states light no chip — they're not a bucket).
  const rawBucket = firstParam(params.bucket);
  const stateBucket = stateFilter ? stateMeta(stateFilter).bucket : null;
  const bucketFilter: Bucket | null = stateFilter
    ? stateBucket !== 'archive' && stateBucket !== null
      ? (stateBucket as Bucket)
      : null
    : rawBucket && isBucket(rawBucket)
      ? rawBucket
      : null;
  const platformFilter = firstParam(params.platform);

  const db = getDb();

  // Base conditions (search + platform) apply to the chip counts too, so the
  // numbers always describe what a click would show.
  const baseConditions: SQL[] = [];
  if (qFilter) {
    const pattern = `%${qFilter.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    const search = or(
      ilike(jobs.company, pattern),
      ilike(jobs.title, pattern),
      ilike(applicationTasks.notes, pattern),
    );
    if (search) baseConditions.push(search);
  }
  if (platformFilter) baseConditions.push(eq(jobs.platform, platformFilter));

  const listConditions: SQL[] = [...baseConditions];
  if (stateFilter) {
    listConditions.push(eq(applicationTasks.state, stateFilter));
  } else if (bucketFilter) {
    listConditions.push(
      inArray(applicationTasks.state, BUCKETS[bucketFilter].states),
    );
  }

  const [platformRows, stateCounts, taskRows] = await Promise.all([
    db
      .selectDistinct({ platform: jobs.platform })
      .from(jobs)
      .orderBy(jobs.platform),
    db
      .select({ state: applicationTasks.state, n: count() })
      .from(applicationTasks)
      .innerJoin(jobs, eq(applicationTasks.jobId, jobs.id))
      .where(baseConditions.length > 0 ? and(...baseConditions) : undefined)
      .groupBy(applicationTasks.state),
    db
      .select({
        id: applicationTasks.id,
        state: applicationTasks.state,
        priority: applicationTasks.priority,
        notes: applicationTasks.notes,
        updatedAt: applicationTasks.updatedAt,
        jobSpec: applicationTasks.jobSpec,
        company: jobs.company,
        title: jobs.title,
        platform: jobs.platform,
        url: jobs.url,
      })
      .from(applicationTasks)
      .innerJoin(jobs, eq(applicationTasks.jobId, jobs.id))
      .where(listConditions.length > 0 ? and(...listConditions) : undefined)
      .orderBy(
        desc(applicationTasks.priority),
        desc(applicationTasks.updatedAt),
      )
      .limit(LIST_CAP),
  ]);
  const platforms = platformRows.map((r) => r.platform);

  const countByState = new Map(
    stateCounts.map((r) => [r.state as string, r.n]),
  );
  const sumStates = (states: readonly TaskState[]) =>
    states.reduce((sum, s) => sum + (countByState.get(s) ?? 0), 0);
  const bucketCount = (bucket: Bucket) => sumStates(BUCKETS[bucket].states);
  const totalTasks = stateCounts.reduce((sum, r) => sum + r.n, 0);
  // How many tasks the current filters select in all (for the cap notice).
  const totalSelected = stateFilter
    ? (countByState.get(stateFilter) ?? 0)
    : bucketFilter
      ? bucketCount(bucketFilter)
      : totalTasks;

  // Latest investigation run per unsupported task (newest-first, first wins)
  // — drives the "unsupported site — …" annotation.
  const unsupportedIds = taskRows
    .filter((r) => r.platform === 'unknown' && r.state === 'NEEDS_INPUT')
    .map((r) => r.id);
  const latestRuns = new Map<string, { status: InvestigationRunStatus }>();
  if (unsupportedIds.length > 0) {
    const runRows = await db
      .select({
        taskId: investigationRuns.taskId,
        status: investigationRuns.status,
      })
      .from(investigationRuns)
      .where(inArray(investigationRuns.taskId, unsupportedIds))
      .orderBy(desc(investigationRuns.startedAt));
    for (const run of runRows) {
      if (!latestRuns.has(run.taskId)) {
        latestRuns.set(run.taskId, { status: run.status });
      }
    }
  }

  const rows: TaskRowData[] = taskRows.map((row) => {
    const meta = stateMeta(row.state);
    const unsupported =
      row.platform === 'unknown' && row.state === 'NEEDS_INPUT';
    let phrase = meta.need;
    let tone: Tone = meta.tone;
    let canInvestigate = false;
    if (unsupported) {
      const status = investigationStatus(latestRuns.get(row.id), row.jobSpec);
      phrase = `unsupported site — ${status.label}`;
      tone = status.tone ?? 'attention';
      canInvestigate = !status.running;
    }
    return {
      id: row.id,
      state: row.state,
      label: rowLabel(row),
      priority: row.priority,
      notes: row.notes,
      tone,
      phrase,
      canInvestigate,
      updatedRel: relativeTime(row.updatedAt),
      updatedAbs: formatLocal(row.updatedAt),
    };
  });
  const inStates = (states: readonly TaskState[]) => {
    const set = new Set<string>(states);
    return rows.filter((r) => set.has(r.state));
  };

  const waiting = inStates(WAITING_STATES);
  const processing = inStates(PROCESSING_STATES);
  const sent = inStates(SENT_STATES);
  const placed = new Set([...waiting, ...processing, ...sent].map((r) => r.id));
  // Archive is the catch-all: FAILED / DUPLICATE / DISCARDED plus any
  // unknown legacy state, so no row can ever silently vanish.
  const archive = rows.filter((r) => !placed.has(r.id));

  // Open the Archive when the filters point straight at it (or a search
  // matched something inside) — a filtered-for row must never hide.
  const archiveOpen =
    archive.length > 0 &&
    ((stateFilter !== null &&
      (ARCHIVE_STATES as string[]).includes(stateFilter)) ||
      bucketFilter === 'stalled' ||
      qFilter !== null);

  const hasFilters =
    qFilter !== null ||
    stateFilter !== null ||
    bucketFilter !== null ||
    platformFilter !== null;

  const bucketChip = (bucket: Bucket) => (
    <Link
      key={bucket}
      href={filterHref({ q: qFilter, bucket, platform: platformFilter })}
      className="chip"
      aria-current={
        bucketFilter === bucket && !stateFilter ? 'true' : undefined
      }
    >
      {BUCKETS[bucket].label}
      <span className="n">{bucketCount(bucket)}</span>
    </Link>
  );

  return (
    <div>
      <h1 className="page-title">Applications</h1>
      <p className="page-sub">
        Everything sower is applying to, in one place. Start with{' '}
        <strong>Waiting on you</strong>.
      </p>

      {/* ---- quick add ---- */}
      <QuickAddBar />

      {/* ---- filter strip: search left, bucket chips + overflow right ---- */}
      <div className="filter-strip">
        <search className="filter-search">
          <form method="GET" action="/">
            <input
              type="search"
              name="q"
              defaultValue={qFilter ?? ''}
              className="field"
              placeholder="Search company, role, notes"
              aria-label="Search applications"
            />
            {bucketFilter && !stateFilter ? (
              <input type="hidden" name="bucket" value={bucketFilter} />
            ) : null}
            {stateFilter ? (
              <input type="hidden" name="state" value={stateFilter} />
            ) : null}
            {platformFilter ? (
              <input type="hidden" name="platform" value={platformFilter} />
            ) : null}
          </form>
        </search>
        <div className="filter-chips">
          {bucketChip('action')}
          {bucketChip('active')}
          {bucketChip('done')}
          <Link
            href={filterHref({ q: qFilter, platform: platformFilter })}
            className="chip"
            aria-current={!bucketFilter && !stateFilter ? 'true' : undefined}
          >
            Everything
            <span className="n">{totalTasks}</span>
          </Link>
          <details className="filter-pop">
            <summary className="chip">Filter ▾</summary>
            <div className="filter-pop-body">
              {platforms.length > 1 ? (
                <>
                  <div className="filter-pop-label">Platform</div>
                  <div className="chip-row" style={{ marginBottom: '0.75rem' }}>
                    <Link
                      href={filterHref({
                        q: qFilter,
                        bucket: bucketFilter,
                        state: stateFilter,
                      })}
                      className="chip"
                      aria-current={
                        platformFilter === null ? 'true' : undefined
                      }
                    >
                      All platforms
                    </Link>
                    {platforms.map((p) => (
                      <Link
                        key={p}
                        href={filterHref({
                          q: qFilter,
                          bucket: bucketFilter,
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
                </>
              ) : null}
              <div className="filter-pop-label">Exact state</div>
              <div className="chip-row">
                {TASK_STATES.filter(
                  (s) => (countByState.get(s) ?? 0) > 0 || stateFilter === s,
                ).map((s) => (
                  <Link
                    key={s}
                    href={filterHref({
                      q: qFilter,
                      state: s,
                      platform: platformFilter,
                    })}
                    className="chip"
                    aria-current={stateFilter === s ? 'true' : undefined}
                  >
                    {stateMeta(s).label}
                    <span className="n">{countByState.get(s) ?? 0}</span>
                  </Link>
                ))}
              </div>
            </div>
          </details>
        </div>
      </div>

      {/* ---- the workspace ---- */}
      {rows.length === 0 ? (
        <div className="card" style={{ marginTop: '1rem' }}>
          {hasFilters ? (
            <p className="hint" style={{ margin: 0 }}>
              No tasks match these filters. <Link href="/">Clear filters</Link>
            </p>
          ) : (
            <p className="hint" style={{ margin: 0 }}>
              Nothing here yet — paste a job link above (or wait for the next
              source poll) and it will show up.
            </p>
          )}
        </div>
      ) : (
        <Workspace>
          <Section title="Waiting on you" rows={waiting} />
          <Section title="New & processing" rows={processing} />
          <section>
            <SectionHeading count={sent.length}>Sent</SectionHeading>
            {sent.length === 0 ? (
              <Empty>none</Empty>
            ) : sent.length <= SENT_VISIBLE ? (
              <RowList rows={sent} />
            ) : (
              <div className="row-list">
                {sent.slice(0, SENT_VISIBLE).map((row) => (
                  <TaskRow key={row.id} row={row} />
                ))}
                <details className="show-more">
                  <summary>show all {sent.length}</summary>
                  {sent.slice(SENT_VISIBLE).map((row) => (
                    <TaskRow key={row.id} row={row} />
                  ))}
                </details>
              </div>
            )}
          </section>
          <details
            className="panel"
            style={{ marginTop: '2rem' }}
            open={archiveOpen || undefined}
          >
            <summary>
              Archive{' '}
              <span className="hint">
                {archive.length} task{archive.length === 1 ? '' : 's'} — failed,
                duplicates, discarded
              </span>
            </summary>
            <div className="panel-body">
              {archive.length === 0 ? (
                <Empty>none</Empty>
              ) : (
                <RowList rows={archive} />
              )}
            </div>
          </details>
        </Workspace>
      )}
      {totalSelected > rows.length ? (
        <Empty>{totalSelected - rows.length} more — refine your search.</Empty>
      ) : null}
    </div>
  );
}
