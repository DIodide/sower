import type { JobSpec, Question } from '@sower/core';
import { applicationTasks, events, jobs } from '@sower/db';
import { and, asc, desc, eq, isNotNull } from 'drizzle-orm';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getDb } from '../../../../lib/db';
import { formatDate, relativeTime } from '../../../../lib/format';
import {
  cellStyle,
  Empty,
  ExpandableText,
  headStyle,
  linkStyle,
  MONO,
  MUTED,
  SectionHeading,
  StateBadge,
  TableWrap,
} from '../../../../lib/ui';

export const dynamic = 'force-dynamic';

interface QuestionUnion {
  question: Question;
  /** How many of this tenant's job specs include the question. */
  present: number;
  required: number;
}

export default async function TenantPage({
  params,
}: {
  params: Promise<{ platform: string; tenant: string }>;
}) {
  const { platform: rawPlatform, tenant: rawTenant } = await params;
  const platform = decodeURIComponent(rawPlatform);
  const tenant = decodeURIComponent(rawTenant);

  const db = getDb();
  const tenantFilter = and(
    eq(jobs.platform, platform),
    eq(jobs.tenant, tenant),
  );

  const [rows, specRows, eventRows] = await Promise.all([
    db
      .select({
        jobId: jobs.id,
        title: jobs.title,
        company: jobs.company,
        url: jobs.url,
        jobCreatedAt: jobs.createdAt,
        taskId: applicationTasks.id,
        state: applicationTasks.state,
        taskUpdatedAt: applicationTasks.updatedAt,
        lastError: applicationTasks.lastError,
      })
      .from(jobs)
      .leftJoin(applicationTasks, eq(applicationTasks.jobId, jobs.id))
      .where(tenantFilter)
      .orderBy(desc(jobs.createdAt)),
    db
      .select({
        jobId: applicationTasks.jobId,
        jobSpec: applicationTasks.jobSpec,
      })
      .from(applicationTasks)
      .innerJoin(jobs, eq(applicationTasks.jobId, jobs.id))
      .where(and(tenantFilter, isNotNull(applicationTasks.jobSpec)))
      .orderBy(asc(applicationTasks.createdAt)),
    db
      .select({
        id: events.id,
        taskId: events.taskId,
        type: events.type,
        fromState: events.fromState,
        toState: events.toState,
        data: events.data,
        createdAt: events.createdAt,
      })
      .from(events)
      .innerJoin(applicationTasks, eq(events.taskId, applicationTasks.id))
      .innerJoin(jobs, eq(applicationTasks.jobId, jobs.id))
      .where(tenantFilter)
      .orderBy(desc(events.createdAt))
      .limit(25),
  ]);

  if (rows.length === 0) notFound();

  const company = rows.find((r) => r.company)?.company ?? null;
  const jobCount = new Set(rows.map((r) => r.jobId)).size;
  const taskCount = rows.filter((r) => r.taskId).length;

  // --- question schema: union of this tenant's job_specs' questions ---------
  const specByJob = new Map<string, JobSpec>();
  for (const row of specRows) {
    if (row.jobSpec) specByJob.set(row.jobId, row.jobSpec);
  }
  const specTotal = specByJob.size;
  const questionUnion = new Map<string, QuestionUnion>();
  for (const spec of specByJob.values()) {
    for (const question of spec.questions ?? []) {
      const entry = questionUnion.get(question.id) ?? {
        question,
        present: 0,
        required: 0,
      };
      entry.present += 1;
      if (question.required) entry.required += 1;
      questionUnion.set(question.id, entry);
    }
  }
  const questionList = [...questionUnion.values()].sort(
    (a, b) =>
      b.present - a.present || a.question.id.localeCompare(b.question.id),
  );

  return (
    <div>
      <h1
        style={{
          fontSize: '1.125rem',
          fontWeight: 600,
          margin: '0 0 0.25rem',
        }}
      >
        {company ?? tenant}
      </h1>
      <p style={{ color: MUTED, fontSize: '0.875rem', margin: 0 }}>
        <Link
          href={`/platforms/${encodeURIComponent(platform)}`}
          style={linkStyle}
        >
          {platform}
        </Link>
        <span style={{ fontFamily: MONO }}> / {tenant}</span> · {jobCount} job
        {jobCount === 1 ? '' : 's'} · {taskCount} task
        {taskCount === 1 ? '' : 's'}
      </p>

      <SectionHeading>jobs &amp; tasks</SectionHeading>
      <TableWrap>
        <thead>
          <tr>
            <th style={headStyle}>job</th>
            <th style={headStyle}>posting</th>
            <th style={headStyle}>task</th>
            <th style={headStyle}>state</th>
            <th style={headStyle}>updated</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={`${row.jobId}:${row.taskId ?? 'none'}`}>
              <td style={cellStyle}>{row.title ?? row.jobId}</td>
              <td style={cellStyle}>
                <a
                  href={row.url}
                  target="_blank"
                  rel="noreferrer"
                  style={linkStyle}
                >
                  open ↗
                </a>
              </td>
              <td style={{ ...cellStyle, fontFamily: MONO }}>
                {row.taskId ? (
                  <Link href={`/tasks/${row.taskId}`} style={linkStyle}>
                    {row.taskId.slice(0, 8)}
                  </Link>
                ) : (
                  <span style={{ color: MUTED }}>no task</span>
                )}
              </td>
              <td style={cellStyle}>
                {row.state ? (
                  <StateBadge state={row.state} />
                ) : (
                  <span style={{ color: MUTED }}>—</span>
                )}
              </td>
              <td
                style={{ ...cellStyle, color: MUTED, whiteSpace: 'nowrap' }}
                title={formatDate(row.taskUpdatedAt ?? row.jobCreatedAt)}
              >
                {relativeTime(row.taskUpdatedAt ?? row.jobCreatedAt)}
              </td>
            </tr>
          ))}
        </tbody>
      </TableWrap>

      <SectionHeading>
        question schema{' '}
        <span style={{ textTransform: 'none', letterSpacing: 0 }}>
          (union across {specTotal} job spec{specTotal === 1 ? '' : 's'})
        </span>
      </SectionHeading>
      {questionList.length === 0 ? (
        <Empty>
          no job specs stored yet — questions appear once tasks are processed.
        </Empty>
      ) : (
        <TableWrap>
          <thead>
            <tr>
              <th style={headStyle}>field id</th>
              <th style={headStyle}>label</th>
              <th style={headStyle}>type</th>
              <th style={headStyle}>required</th>
              <th style={headStyle}>in specs</th>
              <th style={headStyle}>options</th>
            </tr>
          </thead>
          <tbody>
            {questionList.map(({ question, present, required }) => (
              <tr key={question.id}>
                <td style={{ ...cellStyle, fontFamily: MONO }}>
                  {question.id}
                </td>
                <td style={cellStyle}>
                  <ExpandableText text={question.label} max={90} />
                </td>
                <td style={{ ...cellStyle, fontFamily: MONO, color: MUTED }}>
                  {question.type}
                </td>
                <td style={cellStyle}>
                  {required === 0 ? (
                    <span style={{ color: MUTED }}>no</span>
                  ) : required === present ? (
                    'yes'
                  ) : (
                    `${required}/${present}`
                  )}
                </td>
                <td style={{ ...cellStyle, color: MUTED }}>
                  {present}/{specTotal}
                </td>
                <td style={cellStyle}>
                  {question.options && question.options.length > 0 ? (
                    <ExpandableText
                      text={question.options.map((o) => o.label).join(', ')}
                      max={60}
                    />
                  ) : (
                    <span style={{ color: MUTED }}>—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      )}

      <SectionHeading>recent events</SectionHeading>
      {eventRows.length === 0 ? (
        <Empty>no events yet for this tenant.</Empty>
      ) : (
        <TableWrap>
          <thead>
            <tr>
              <th style={headStyle}>when</th>
              <th style={headStyle}>event</th>
              <th style={headStyle}>transition</th>
              <th style={headStyle}>task</th>
              <th style={headStyle}>data</th>
            </tr>
          </thead>
          <tbody>
            {eventRows.map((event) => (
              <tr key={event.id}>
                <td
                  style={{ ...cellStyle, color: MUTED, whiteSpace: 'nowrap' }}
                  title={formatDate(event.createdAt)}
                >
                  {relativeTime(event.createdAt)}
                </td>
                <td style={{ ...cellStyle, fontFamily: MONO }}>{event.type}</td>
                <td style={{ ...cellStyle, whiteSpace: 'nowrap' }}>
                  {event.fromState ? (
                    <StateBadge state={event.fromState} />
                  ) : (
                    <span style={{ color: MUTED }}>—</span>
                  )}
                  <span style={{ color: MUTED }}> → </span>
                  {event.toState ? (
                    <StateBadge state={event.toState} />
                  ) : (
                    <span style={{ color: MUTED }}>—</span>
                  )}
                </td>
                <td style={{ ...cellStyle, fontFamily: MONO }}>
                  <Link href={`/tasks/${event.taskId}`} style={linkStyle}>
                    {event.taskId.slice(0, 8)}
                  </Link>
                </td>
                <td style={cellStyle}>
                  {event.data == null ? (
                    <span style={{ color: MUTED }}>—</span>
                  ) : (
                    <ExpandableText
                      text={JSON.stringify(event.data, null, 2)}
                      max={80}
                    />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      )}
    </div>
  );
}
