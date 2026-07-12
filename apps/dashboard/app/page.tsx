// NOTE: no auth on this dashboard — it is read-only and intended to run
// locally / on a private network only. Do not expose it publicly as-is.
import { applicationTasks, createDb, jobs } from '@sower/db';
import { desc, eq } from 'drizzle-orm';
import type { CSSProperties } from 'react';

export const dynamic = 'force-dynamic';

// Reuse one connection pool across requests instead of reconnecting on every
// render (the page is force-dynamic).
let dbSingleton: ReturnType<typeof createDb> | null = null;

function getDb(url: string) {
  dbSingleton ??= createDb(url);
  return dbSingleton;
}

const STATE_COLORS: Record<string, { bg: string; fg: string }> = {
  INGESTED: { bg: '#16283f', fg: '#60a5fa' },
  PARSED: { bg: '#16283f', fg: '#60a5fa' },
  QUEUED: { bg: '#16283f', fg: '#93c5fd' },
  PREPARING: { bg: '#2a2140', fg: '#a78bfa' },
  NEEDS_INPUT: { bg: '#3a2f14', fg: '#fbbf24' },
  REVIEW: { bg: '#3a2f14', fg: '#fbbf24' },
  AWAITING_OTP: { bg: '#3a2f14', fg: '#fcd34d' },
  FILLING: { bg: '#2a2140', fg: '#c4b5fd' },
  SUBMITTED: { bg: '#143322', fg: '#34d399' },
  CONFIRMED: { bg: '#143322', fg: '#4ade80' },
  FAILED: { bg: '#3a1a1a', fg: '#f87171' },
  DUPLICATE: { bg: '#26262b', fg: '#9ca3af' },
};

const FALLBACK_COLOR = { bg: '#26262b', fg: '#9ca3af' };

function StateBadge({ state }: { state: string }) {
  const color = STATE_COLORS[state] ?? FALLBACK_COLOR;
  return (
    <span
      style={{
        backgroundColor: color.bg,
        color: color.fg,
        borderRadius: '9999px',
        padding: '0.125rem 0.625rem',
        fontSize: '0.75rem',
        fontWeight: 600,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        whiteSpace: 'nowrap',
      }}
    >
      {state}
    </span>
  );
}

const cellStyle: CSSProperties = {
  padding: '0.5rem 0.75rem',
  borderBottom: '1px solid #1c2130',
  textAlign: 'left',
  fontSize: '0.875rem',
};

const headStyle: CSSProperties = {
  ...cellStyle,
  color: '#8b93a7',
  fontSize: '0.75rem',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
};

function formatTime(value: Date | null): string {
  if (!value) return '—';
  return `${value.toISOString().replace('T', ' ').slice(0, 16)} UTC`;
}

export default async function Page() {
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    return (
      <p style={{ color: '#fbbf24' }}>
        set <code>DATABASE_URL</code> to view application tasks.
      </p>
    );
  }

  const db = getDb(databaseUrl);
  const rows = await db
    .select({
      id: applicationTasks.id,
      state: applicationTasks.state,
      updatedAt: applicationTasks.updatedAt,
      company: jobs.company,
      title: jobs.title,
      platform: jobs.platform,
    })
    .from(applicationTasks)
    .innerJoin(jobs, eq(applicationTasks.jobId, jobs.id))
    .orderBy(desc(applicationTasks.updatedAt))
    .limit(50);

  if (rows.length === 0) {
    return <p style={{ color: '#8b93a7' }}>no application tasks yet.</p>;
  }

  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
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
              <td style={cellStyle}>{row.title ?? '—'}</td>
              <td
                style={{
                  ...cellStyle,
                  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                }}
              >
                {row.platform}
              </td>
              <td style={cellStyle}>
                <StateBadge state={row.state} />
              </td>
              <td style={{ ...cellStyle, color: '#8b93a7' }}>
                {formatTime(row.updatedAt)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
