import type { TaskState } from '@sower/core';
import {
  applicationTasks,
  events,
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
  notInArray,
  or,
  type SQL,
} from 'drizzle-orm';
import Link from 'next/link';
import { getDb } from '../lib/db';
import {
  BUCKETS,
  type Bucket,
  deadlineChipLabel,
  formatLocal,
  isBucket,
  isDeadlineSoon,
  relativeTime,
  rowLabel,
  STATE_META,
  stateMeta,
  type Tone,
} from '../lib/format';
import { Empty, SectionHeading } from '../lib/ui';
import { QuickAddBar } from './quick-add-bar';
import { SearchBox } from './search-box';
import { TaskRow, type TaskRowData } from './task-row';
import { Workspace } from './workspace';

export const dynamic = 'force-dynamic';

const TASK_STATES = Object.keys(STATE_META) as TaskState[];

/** Cap for the non-action sections: enough to scan, never the whole history.
 *  "Waiting on you" is deliberately NEVER capped — work waiting on the user
 *  must never be silently hidden. */
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

/** Rows whose deadline chip would be noise: already sent, or archived. */
const DEADLINE_HIDDEN_STATES = new Set<string>([
  ...SENT_STATES,
  ...ARCHIVE_STATES,
]);

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

/** One section: heading + grid rows, or a one-line "none". `count` is the
 *  TRUE total under the current filters (it may exceed the rows fetched when
 *  the shared list cap truncated this section). */
function Section({
  title,
  rows,
  count,
}: {
  title: string;
  rows: TaskRowData[];
  count?: number;
}) {
  return (
    <section>
      <SectionHeading count={count ?? rows.length}>{title}</SectionHeading>
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

  const taskSelection = {
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
    deadline: jobs.deadline,
  };

  // Two row queries: the action bucket ("Waiting on you") is NEVER capped —
  // work waiting on the user must all be visible — while everything else
  // shares the LIST_CAP.
  const [platformRows, stateCounts, waitingRows, otherRows] = await Promise.all(
    [
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
        .select(taskSelection)
        .from(applicationTasks)
        .innerJoin(jobs, eq(applicationTasks.jobId, jobs.id))
        .where(
          and(
            ...listConditions,
            inArray(applicationTasks.state, [...WAITING_STATES]),
          ),
        )
        .orderBy(
          desc(applicationTasks.priority),
          desc(applicationTasks.updatedAt),
        ),
      db
        .select(taskSelection)
        .from(applicationTasks)
        .innerJoin(jobs, eq(applicationTasks.jobId, jobs.id))
        .where(
          and(
            ...listConditions,
            notInArray(applicationTasks.state, [...WAITING_STATES]),
          ),
        )
        .orderBy(
          desc(applicationTasks.priority),
          desc(applicationTasks.updatedAt),
        )
        .limit(LIST_CAP),
    ],
  );
  const taskRows = [...waitingRows, ...otherRows];
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

  // True per-section totals under the CURRENT filters, computed from the same
  // grouped counts the chips use — a heading can never disagree with a chip,
  // and stays honest even when the fetched list was capped.
  const filteredStates: readonly TaskState[] | null = stateFilter
    ? [stateFilter]
    : bucketFilter
      ? BUCKETS[bucketFilter].states
      : null;
  const sectionTotal = (states: readonly TaskState[]) =>
    states
      .filter((s) => filteredStates === null || filteredStates.includes(s))
      .reduce((sum, s) => sum + (countByState.get(s) ?? 0), 0);
  const waitingTotal = sectionTotal(WAITING_STATES);
  const processingTotal = sectionTotal(PROCESSING_STATES);
  const sentTotal = sectionTotal(SENT_STATES);
  // Archive is the catch-all, so its total absorbs unknown legacy states too.
  const archiveTotal =
    totalSelected - waitingTotal - processingTotal - sentTotal;
  // How many capped-section rows the LIST_CAP actually cut off (0 = no cap
  // notice; the waiting query is uncapped and never truncates).
  const capTruncated = Math.max(
    0,
    processingTotal + sentTotal + archiveTotal - otherRows.length,
  );

  // Latest investigation run per unsupported task (newest-first, first wins)
  // — drives the "unsupported site — …" annotation.
  const unsupportedIds = taskRows
    .filter((r) => r.platform === 'unknown' && r.state === 'NEEDS_INPUT')
    .map((r) => r.id);
  // Discarded rows on this page only: their latest DISCARD event tells
  // whether the system's rule (data.reason 'auto') or a human removed them,
  // plus the optional "why" note.
  const discardedIds = taskRows
    .filter((r) => r.state === 'DISCARDED')
    .map((r) => r.id);
  const [runRows, discardRows] = await Promise.all([
    unsupportedIds.length > 0
      ? db
          .select({
            taskId: investigationRuns.taskId,
            status: investigationRuns.status,
          })
          .from(investigationRuns)
          .where(inArray(investigationRuns.taskId, unsupportedIds))
          .orderBy(desc(investigationRuns.startedAt))
      : [],
    discardedIds.length > 0
      ? db
          .select({ taskId: events.taskId, data: events.data })
          .from(events)
          .where(
            and(
              eq(events.type, 'DISCARD'),
              inArray(events.taskId, discardedIds),
            ),
          )
          .orderBy(desc(events.createdAt))
      : [],
  ]);
  const latestRuns = new Map<string, { status: InvestigationRunStatus }>();
  for (const run of runRows) {
    if (!latestRuns.has(run.taskId)) {
      latestRuns.set(run.taskId, { status: run.status });
    }
  }
  // Newest-first, so the FIRST row per task is its latest DISCARD.
  const latestDiscards = new Map<
    string,
    { auto: boolean; note: string | null }
  >();
  for (const row of discardRows) {
    if (latestDiscards.has(row.taskId)) continue;
    const data =
      row.data && typeof row.data === 'object' && !Array.isArray(row.data)
        ? (row.data as Record<string, unknown>)
        : undefined;
    const note = data?.note;
    latestDiscards.set(row.taskId, {
      auto: data?.reason === 'auto',
      note: typeof note === 'string' && note !== '' ? note : null,
    });
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
    const discard =
      row.state === 'DISCARDED' ? latestDiscards.get(row.id) : undefined;
    if (discard?.auto) phrase = 'Auto discarded';
    const statusNote = discard?.note ?? null;
    const employmentType = row.jobSpec?.employmentType?.trim() || null;
    // Compact deadline chip — only while the task can still be acted on
    // (never on Sent or Archive rows). Precomputed on the server so
    // hydration never disagrees on "now".
    const showDeadline =
      row.deadline !== null && !DEADLINE_HIDDEN_STATES.has(row.state);
    return {
      id: row.id,
      state: row.state,
      label: rowLabel(row),
      priority: row.priority,
      notes: row.notes,
      tone,
      phrase,
      statusNote,
      // Faint "· Intern" type hint — skipped when the discard note already
      // names it ("… Employment type: Full time · Full time" reads twice).
      employmentType:
        employmentType &&
        !statusNote?.toLowerCase().includes(employmentType.toLowerCase())
          ? employmentType
          : null,
      canInvestigate,
      deadline: showDeadline ? deadlineChipLabel(row.deadline) : null,
      deadlineSoon: showDeadline ? isDeadlineSoon(row.deadline) : false,
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
          <SearchBox />
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
                  <div className="chip-row" style={{ marginBottom: '0.5rem' }}>
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
        <div className="card" style={{ marginTop: '0.5rem' }}>
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
          <Section
            title="New & processing"
            rows={processing}
            count={processingTotal}
          />
          <section>
            <SectionHeading count={sentTotal}>Sent</SectionHeading>
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
                  <summary>show {sent.length - SENT_VISIBLE} more</summary>
                  {sent.slice(SENT_VISIBLE).map((row) => (
                    <TaskRow key={row.id} row={row} />
                  ))}
                </details>
              </div>
            )}
          </section>
          <details
            className="panel"
            style={{ marginTop: '1.5rem' }}
            open={archiveOpen || undefined}
          >
            <summary>
              Archive{' '}
              <span className="hint">
                {archiveTotal} task{archiveTotal === 1 ? '' : 's'} — failed,
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
      {/* Only shown when the shared cap actually truncated something —
          "Waiting on you" is never capped, so it is never affected. */}
      {capTruncated > 0 ? (
        <Empty>
          {capTruncated} more (outside "Waiting on you") not shown — refine your
          search or filters to see them.
        </Empty>
      ) : null}
    </div>
  );
}
