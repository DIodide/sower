import type { JobSpec, Question } from '@sower/core';
import { applicationTasks, events, jobs } from '@sower/db';
import { and, asc, desc, eq, isNotNull } from 'drizzle-orm';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getDb } from '../../../../lib/db';
import { formatDate, relativeTime } from '../../../../lib/format';
import {
  Empty,
  ExpandableText,
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
      <p style={{ margin: '0 0 1rem' }}>
        <Link
          href={`/platforms/${encodeURIComponent(platform)}`}
          className="hint"
        >
          ← {platform}
        </Link>
      </p>
      <h1 className="page-title">{company ?? tenant}</h1>
      <p className="page-sub">
        <Link href={`/platforms/${encodeURIComponent(platform)}`}>
          {platform}
        </Link>
        <span className="mono"> / {tenant}</span> · {jobCount} job
        {jobCount === 1 ? '' : 's'} · {taskCount} task
        {taskCount === 1 ? '' : 's'}
      </p>

      <SectionHeading>Jobs &amp; tasks</SectionHeading>
      <TableWrap>
        <thead>
          <tr>
            <th>Job</th>
            <th>Posting</th>
            <th>Task</th>
            <th>State</th>
            <th>Updated</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={`${row.jobId}:${row.taskId ?? 'none'}`}>
              <td className="cell-main">{row.title ?? row.jobId}</td>
              <td>
                <a href={row.url} target="_blank" rel="noreferrer">
                  open ↗
                </a>
              </td>
              <td className="mono">
                {row.taskId ? (
                  <Link href={`/tasks/${row.taskId}`}>
                    {row.taskId.slice(0, 8)}
                  </Link>
                ) : (
                  <span className="faint">no task</span>
                )}
              </td>
              <td>
                {row.state ? (
                  <StateBadge state={row.state} />
                ) : (
                  <span className="faint">—</span>
                )}
              </td>
              <td
                className="faint"
                style={{ whiteSpace: 'nowrap' }}
                title={formatDate(row.taskUpdatedAt ?? row.jobCreatedAt)}
              >
                {relativeTime(row.taskUpdatedAt ?? row.jobCreatedAt)}
              </td>
            </tr>
          ))}
        </tbody>
      </TableWrap>

      <SectionHeading>
        Question schema{' '}
        <span className="hint" style={{ fontWeight: 600 }}>
          union across {specTotal} job spec{specTotal === 1 ? '' : 's'}
        </span>
      </SectionHeading>
      {questionList.length === 0 ? (
        <Empty>
          No job specs stored yet — questions appear once tasks are processed.
        </Empty>
      ) : (
        <TableWrap>
          <thead>
            <tr>
              <th>Field id</th>
              <th>Label</th>
              <th>Type</th>
              <th>Required</th>
              <th>In specs</th>
              <th>Options</th>
            </tr>
          </thead>
          <tbody>
            {questionList.map(({ question, present, required }) => (
              <tr key={question.id}>
                <td className="mono">{question.id}</td>
                <td>
                  <ExpandableText text={question.label} max={90} />
                </td>
                <td className="mono faint">{question.type}</td>
                <td>
                  {required === 0 ? (
                    <span className="faint">no</span>
                  ) : required === present ? (
                    'yes'
                  ) : (
                    `${required}/${present}`
                  )}
                </td>
                <td className="num faint">
                  {present}/{specTotal}
                </td>
                <td>
                  {question.options && question.options.length > 0 ? (
                    <ExpandableText
                      text={question.options.map((o) => o.label).join(', ')}
                      max={60}
                    />
                  ) : (
                    <span className="faint">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      )}

      <SectionHeading>Recent events</SectionHeading>
      {eventRows.length === 0 ? (
        <Empty>No events yet for this tenant.</Empty>
      ) : (
        <TableWrap>
          <thead>
            <tr>
              <th>When</th>
              <th>Event</th>
              <th>Transition</th>
              <th>Task</th>
              <th>Data</th>
            </tr>
          </thead>
          <tbody>
            {eventRows.map((event) => (
              <tr key={event.id}>
                <td
                  className="faint"
                  style={{ whiteSpace: 'nowrap' }}
                  title={formatDate(event.createdAt)}
                >
                  {relativeTime(event.createdAt)}
                </td>
                <td className="mono">{event.type}</td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  {event.fromState ? (
                    <StateBadge state={event.fromState} />
                  ) : (
                    <span className="faint">—</span>
                  )}
                  <span className="faint"> → </span>
                  {event.toState ? (
                    <StateBadge state={event.toState} />
                  ) : (
                    <span className="faint">—</span>
                  )}
                </td>
                <td className="mono">
                  <Link href={`/tasks/${event.taskId}`}>
                    {event.taskId.slice(0, 8)}
                  </Link>
                </td>
                <td>
                  {event.data == null ? (
                    <span className="faint">—</span>
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
