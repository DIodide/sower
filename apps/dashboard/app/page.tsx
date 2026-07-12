import { ALLOWED, type TaskState } from '@sower/core';
import { applicationTasks, jobs } from '@sower/db';
import { and, desc, eq, type SQL } from 'drizzle-orm';
import Link from 'next/link';
import type { CSSProperties } from 'react';
import { getDb } from '../lib/db';
import { formatDate, relativeTime } from '../lib/format';
import {
  cellStyle,
  Empty,
  headStyle,
  linkStyle,
  MONO,
  MUTED,
  StateBadge,
  TableWrap,
} from '../lib/ui';

export const dynamic = 'force-dynamic';

const TASK_STATES = Object.keys(ALLOWED) as TaskState[];

function isTaskState(value: string): value is TaskState {
  return (TASK_STATES as string[]).includes(value);
}

function firstParam(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function filterHref(state: string | null, platform: string | null): string {
  const qs = new URLSearchParams();
  if (state) qs.set('state', state);
  if (platform) qs.set('platform', platform);
  const s = qs.toString();
  return s ? `/?${s}` : '/';
}

function FilterChip({
  href,
  active,
  label,
}: {
  href: string;
  active: boolean;
  label: string;
}) {
  const style: CSSProperties = {
    color: active ? '#d7dae0' : MUTED,
    backgroundColor: active ? '#1c2130' : 'transparent',
    border: `1px solid ${active ? '#2a3147' : '#1c2130'}`,
    borderRadius: '9999px',
    padding: '0.125rem 0.625rem',
    fontSize: '0.75rem',
    fontFamily: MONO,
    textDecoration: 'none',
    whiteSpace: 'nowrap',
  };
  return (
    <Link href={href} style={style}>
      {label}
    </Link>
  );
}

function FilterRow({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: '0.375rem',
        marginBottom: '0.5rem',
      }}
    >
      <span
        style={{
          color: MUTED,
          fontSize: '0.75rem',
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
          marginRight: '0.25rem',
          minWidth: '4.5rem',
        }}
      >
        {title}
      </span>
      {children}
    </div>
  );
}

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const rawState = firstParam(params.state);
  const stateFilter = rawState && isTaskState(rawState) ? rawState : null;
  const platformFilter = firstParam(params.platform);

  const db = getDb();

  const platformRows = await db
    .selectDistinct({ platform: jobs.platform })
    .from(jobs)
    .orderBy(jobs.platform);
  const platforms = platformRows.map((r) => r.platform);

  const conditions: SQL[] = [];
  if (stateFilter) conditions.push(eq(applicationTasks.state, stateFilter));
  if (platformFilter) conditions.push(eq(jobs.platform, platformFilter));

  const rows = await db
    .select({
      id: applicationTasks.id,
      state: applicationTasks.state,
      updatedAt: applicationTasks.updatedAt,
      company: jobs.company,
      title: jobs.title,
      platform: jobs.platform,
      tenant: jobs.tenant,
    })
    .from(applicationTasks)
    .innerJoin(jobs, eq(applicationTasks.jobId, jobs.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(applicationTasks.updatedAt))
    .limit(200);

  const hasFilters = stateFilter !== null || platformFilter !== null;

  return (
    <div>
      <FilterRow title="state">
        <FilterChip
          href={filterHref(null, platformFilter)}
          active={stateFilter === null}
          label="all"
        />
        {TASK_STATES.map((s) => (
          <FilterChip
            key={s}
            href={filterHref(s, platformFilter)}
            active={stateFilter === s}
            label={s}
          />
        ))}
      </FilterRow>
      <FilterRow title="platform">
        <FilterChip
          href={filterHref(stateFilter, null)}
          active={platformFilter === null}
          label="all"
        />
        {platforms.map((p) => (
          <FilterChip
            key={p}
            href={filterHref(stateFilter, p)}
            active={platformFilter === p}
            label={p}
          />
        ))}
      </FilterRow>

      {rows.length === 0 ? (
        hasFilters ? (
          <Empty>
            no tasks match these filters.{' '}
            <Link href="/" style={linkStyle}>
              clear filters
            </Link>
          </Empty>
        ) : (
          <Empty>no application tasks yet.</Empty>
        )
      ) : (
        <TableWrap>
          <thead>
            <tr>
              <th style={headStyle}>company</th>
              <th style={headStyle}>title</th>
              <th style={headStyle}>platform</th>
              <th style={headStyle}>state</th>
              <th style={headStyle}>updated</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td style={cellStyle}>{row.company ?? '—'}</td>
                <td style={cellStyle}>
                  <Link href={`/tasks/${row.id}`} style={linkStyle}>
                    {row.title ?? row.id}
                  </Link>
                </td>
                <td style={{ ...cellStyle, fontFamily: MONO }}>
                  {row.platform}
                  {row.tenant ? (
                    <span style={{ color: MUTED }}> / {row.tenant}</span>
                  ) : null}
                </td>
                <td style={cellStyle}>
                  <StateBadge state={row.state} />
                </td>
                <td
                  style={{ ...cellStyle, color: MUTED, whiteSpace: 'nowrap' }}
                  title={formatDate(row.updatedAt)}
                >
                  {relativeTime(row.updatedAt)}
                </td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      )}
    </div>
  );
}
