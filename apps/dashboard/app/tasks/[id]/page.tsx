import type { Question, ResolvedAnswer } from '@sower/core';
import type { Document } from '@sower/db';
import { apiCalls, applicationTasks, documents, events, jobs } from '@sower/db';
import { asc, desc, eq } from 'drizzle-orm';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { CSSProperties, ReactNode } from 'react';
import { getDb } from '../../../lib/db';
import { formatDate, relativeTime } from '../../../lib/format';
import {
  BORDER,
  Empty,
  ExpandableText,
  linkStyle,
  MONO,
  MUTED,
  PANEL_BG,
  SectionHeading,
  StateBadge,
} from '../../../lib/ui';
import { NeedsInputForm } from './needs-input-form';
import { documentKind } from './question-kind';
import type { DocumentOption, QuestionView } from './questions-panel';
import { QuestionsPanel } from './questions-panel';
import { TaskActions } from './task-actions';
import { Badge, FAINT, JsonDetails } from './ui';

export const dynamic = 'force-dynamic';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const FALLBACK_STATUS_COLOR = { bg: '#26262b', fg: '#9ca3af' };

const metaTermStyle: CSSProperties = {
  fontSize: '0.7rem',
  color: MUTED,
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  fontFamily: MONO,
};

const metaValueStyle: CSSProperties = {
  fontSize: '0.875rem',
  margin: 0,
  overflowWrap: 'anywhere',
};

const CALL_GRID_COLUMNS =
  '2.5rem 6.5rem 3.5rem minmax(10rem, 1fr) 3.5rem 5rem 4.5rem';

function MetaItem({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={metaTermStyle}>{label}</div>
      <div style={metaValueStyle}>{children}</div>
    </div>
  );
}

/**
 * Render event data legibly: primitive fields (park reasons, error strings,
 * counts) inline, with the full object behind an expander when it holds
 * nested structures (e.g. missing question lists).
 */
function EventData({ data }: { data: unknown }) {
  if (data === null || data === undefined) return null;
  if (typeof data !== 'object' || Array.isArray(data)) {
    return <JsonDetails label="data" value={data} />;
  }
  const entries = Object.entries(data as Record<string, unknown>);
  if (entries.length === 0) return null;
  const primitives = entries.filter(
    ([, v]) =>
      v === null ||
      typeof v === 'string' ||
      typeof v === 'number' ||
      typeof v === 'boolean',
  );
  return (
    <div style={{ marginTop: '0.25rem' }}>
      {primitives.map(([key, value]) => (
        <div key={key} style={{ fontSize: '0.75rem', marginTop: '0.125rem' }}>
          <span style={{ color: MUTED, fontFamily: MONO }}>{key}: </span>
          <ExpandableText text={String(value)} max={160} />
        </div>
      ))}
      {primitives.length !== entries.length ? (
        <JsonDetails label="full event data" value={data} />
      ) : null}
    </div>
  );
}

function httpStatusColor(status: number | null): { bg: string; fg: string } {
  if (status === null) return FALLBACK_STATUS_COLOR;
  if (status >= 200 && status < 300) return { bg: '#143322', fg: '#4ade80' };
  if (status >= 400) return { bg: '#3a1a1a', fg: '#f87171' };
  return { bg: '#3a2f14', fg: '#fbbf24' };
}

function buildQuestionViews(
  questions: Question[],
  resolved: ResolvedAnswer[],
  missing: Question[],
  hasResolution: boolean,
  docByPath: Map<string, Document>,
): QuestionView[] {
  const resolvedById = new Map(resolved.map((r) => [r.questionId, r]));
  const missingIds = new Set(missing.map((q) => q.id));

  return questions.map((question) => {
    const answer = resolvedById.get(question.id);
    const options = (question.options ?? []).map((o) => ({
      label: o.label,
      value: String(o.value),
    }));
    const base = {
      id: question.id,
      label: question.label,
      type: question.type,
      required: question.required,
      options,
      docKind: documentKind(question),
    };

    if (answer) {
      const rawValues =
        answer.value === null
          ? []
          : Array.isArray(answer.value)
            ? answer.value
            : [answer.value];
      let display = rawValues;
      if (answer.source === 'document') {
        // The stored value is a storage path; show the document's filename.
        display = rawValues.map((path) => {
          const doc = docByPath.get(path);
          return doc ? `${doc.filename} (${doc.kind})` : path;
        });
      } else if (
        question.type === 'select' ||
        question.type === 'multiselect'
      ) {
        display = rawValues.map(
          (v) => options.find((o) => o.value === v)?.label ?? v,
        );
      }
      return {
        ...base,
        status: 'resolved' as const,
        resolvedSource: answer.source,
        resolvedValues: display,
      };
    }

    if (!hasResolution) return { ...base, status: 'unknown' as const };
    return {
      ...base,
      status: missingIds.has(question.id)
        ? ('missing' as const)
        : ('unknown' as const),
    };
  });
}

export default async function TaskPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (!UUID_RE.test(id)) notFound();

  const db = getDb();

  const taskRows = await db
    .select()
    .from(applicationTasks)
    .where(eq(applicationTasks.id, id))
    .limit(1);
  const task = taskRows[0];
  if (!task) notFound();

  const [jobRows, eventRows, callRows, documentRows] = await Promise.all([
    db.select().from(jobs).where(eq(jobs.id, task.jobId)).limit(1),
    db
      .select()
      .from(events)
      .where(eq(events.taskId, id))
      .orderBy(asc(events.createdAt)),
    db
      .select()
      .from(apiCalls)
      .where(eq(apiCalls.taskId, id))
      .orderBy(asc(apiCalls.seq)),
    db.select().from(documents).orderBy(desc(documents.createdAt)),
  ]);
  const job = jobRows[0];

  const spec = task.jobSpec;
  const resolution = task.resolution;
  const docByPath = new Map(documentRows.map((d) => [d.storagePath, d]));
  const views = spec
    ? buildQuestionViews(
        spec.questions,
        resolution?.resolved ?? [],
        resolution?.missing ?? [],
        resolution != null,
        docByPath,
      )
    : [];
  const documentOptions: DocumentOption[] = documentRows.map((d) => ({
    id: d.id,
    kind: d.kind,
    filename: d.filename,
    createdLabel: formatDate(d.createdAt),
  }));
  const resolvedCount = views.filter((v) => v.status === 'resolved').length;
  const missingCount = views.filter((v) => v.status === 'missing').length;

  return (
    <div>
      <p style={{ margin: '0 0 0.75rem 0', fontSize: '0.8rem' }}>
        <Link href="/" style={{ ...linkStyle, color: MUTED }}>
          ← tasks
        </Link>
      </p>

      {/* ---- header ---- */}
      <header>
        <div
          style={{
            display: 'flex',
            alignItems: 'baseline',
            gap: '0.75rem',
            flexWrap: 'wrap',
            marginBottom: '0.75rem',
          }}
        >
          <h2 style={{ margin: 0, fontSize: '1.125rem', fontWeight: 600 }}>
            {job?.company ?? '—'}{' '}
            <span style={{ color: MUTED, fontWeight: 400 }}>
              — {job?.title ?? 'untitled role'}
            </span>
          </h2>
          <StateBadge state={task.state} />
          <span style={{ fontSize: '0.75rem', color: FAINT, fontFamily: MONO }}>
            attempt {task.attempt}
          </span>
        </div>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(11rem, 1fr))',
            gap: '0.75rem 1.5rem',
            backgroundColor: PANEL_BG,
            border: `1px solid ${BORDER}`,
            borderRadius: '0.5rem',
            padding: '1rem 1.25rem',
          }}
        >
          <MetaItem label="platform">
            {job ? (
              <Link
                href={`/platforms/${encodeURIComponent(job.platform)}`}
                style={{ ...linkStyle, fontFamily: MONO }}
              >
                {job.platform}
              </Link>
            ) : (
              '—'
            )}
          </MetaItem>
          <MetaItem label="tenant">
            {job?.tenant ? (
              <Link
                href={`/tenants/${encodeURIComponent(job.platform)}/${encodeURIComponent(job.tenant)}`}
                style={{ ...linkStyle, fontFamily: MONO }}
              >
                {job.tenant}
              </Link>
            ) : (
              '—'
            )}
          </MetaItem>
          <MetaItem label="posting">
            {job?.url ? (
              <a
                href={job.url}
                target="_blank"
                rel="noopener noreferrer"
                style={linkStyle}
              >
                <span
                  style={{
                    display: 'inline-block',
                    maxWidth: '100%',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    verticalAlign: 'bottom',
                  }}
                  title={job.url}
                >
                  {job.url}
                </span>
              </a>
            ) : (
              '—'
            )}
          </MetaItem>
          <MetaItem label="source">{job?.source ?? '—'}</MetaItem>
          <MetaItem label="created">{formatDate(task.createdAt)}</MetaItem>
          <MetaItem label="updated">
            {formatDate(task.updatedAt)}
            {task.updatedAt ? (
              <span style={{ color: FAINT }}>
                {' '}
                · {relativeTime(task.updatedAt)}
              </span>
            ) : null}
          </MetaItem>
          <MetaItem label="terms">
            {job?.terms && job.terms.length > 0 ? (
              <span
                style={{
                  display: 'inline-flex',
                  gap: '0.375rem',
                  flexWrap: 'wrap',
                }}
              >
                {job.terms.map((term) => (
                  <Badge key={term} bg="#26262b" fg="#9ca3af">
                    {term}
                  </Badge>
                ))}
              </span>
            ) : (
              '—'
            )}
          </MetaItem>
          {task.lastError ? (
            <div style={{ gridColumn: '1 / -1', minWidth: 0 }}>
              <div style={metaTermStyle}>last error</div>
              <div style={{ ...metaValueStyle, color: '#f87171' }}>
                <ExpandableText text={task.lastError} max={160} />
              </div>
            </div>
          ) : null}
        </div>
      </header>

      {/* ---- state timeline ---- */}
      <SectionHeading>state timeline</SectionHeading>
      {eventRows.length === 0 ? (
        <Empty>no events recorded for this task yet.</Empty>
      ) : (
        <ol style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {eventRows.map((event) => (
            <li
              key={event.id}
              style={{
                padding: '0.625rem 0',
                borderBottom: `1px solid ${BORDER}`,
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'baseline',
                  gap: '0.625rem',
                  flexWrap: 'wrap',
                }}
              >
                <span
                  style={{
                    fontFamily: MONO,
                    fontSize: '0.8rem',
                    fontWeight: 700,
                  }}
                >
                  {event.type}
                </span>
                {event.fromState || event.toState ? (
                  <span
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '0.375rem',
                    }}
                  >
                    {event.fromState ? (
                      <StateBadge state={event.fromState} />
                    ) : null}
                    {event.fromState && event.toState ? (
                      <span style={{ color: FAINT }}>→</span>
                    ) : null}
                    {event.toState ? (
                      <StateBadge state={event.toState} />
                    ) : null}
                  </span>
                ) : null}
                <span
                  style={{
                    marginLeft: 'auto',
                    fontSize: '0.75rem',
                    color: MUTED,
                    whiteSpace: 'nowrap',
                  }}
                >
                  {formatDate(event.createdAt)}
                  {event.createdAt ? (
                    <span style={{ color: FAINT }}>
                      {' '}
                      · {relativeTime(event.createdAt)}
                    </span>
                  ) : null}
                </span>
              </div>
              <EventData data={event.data} />
            </li>
          ))}
        </ol>
      )}

      {/* ---- form & answers ---- */}
      <SectionHeading>form &amp; answers</SectionHeading>
      {spec ? (
        <p
          style={{ margin: '0 0 0.5rem 0', fontSize: '0.75rem', color: FAINT }}
        >
          {resolvedCount} resolved · {missingCount} unanswered
          {task.state === 'NEEDS_INPUT'
            ? ' — fill in the fields below; saved answers go to the answers bank and apply on requeue.'
            : ''}
        </p>
      ) : null}
      {!spec ? (
        <Empty>
          no job spec captured yet — the task has not been processed.
        </Empty>
      ) : task.state === 'NEEDS_INPUT' ? (
        <NeedsInputForm
          taskId={task.id}
          views={views}
          documents={documentOptions}
        />
      ) : (
        <QuestionsPanel views={views} />
      )}

      {/* ---- api calls ---- */}
      <SectionHeading>api calls</SectionHeading>
      {callRows.length === 0 ? (
        <Empty>no api calls recorded for this task yet.</Empty>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <div style={{ minWidth: '42rem' }}>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: CALL_GRID_COLUMNS,
                gap: '0.5rem',
                padding: '0.375rem 0.5rem',
                fontSize: '0.7rem',
                color: MUTED,
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
                fontFamily: MONO,
              }}
            >
              <span>seq</span>
              <span>phase</span>
              <span>method</span>
              <span>url</span>
              <span>status</span>
              <span>duration</span>
              <span>mode</span>
            </div>
            {callRows.map((call) => {
              const statusColor = httpStatusColor(call.responseStatus);
              return (
                <details
                  key={call.id}
                  style={{ borderTop: `1px solid ${BORDER}` }}
                >
                  <summary
                    style={{
                      display: 'grid',
                      gridTemplateColumns: CALL_GRID_COLUMNS,
                      gap: '0.5rem',
                      alignItems: 'baseline',
                      padding: '0.5rem',
                      cursor: 'pointer',
                      fontSize: '0.8rem',
                    }}
                  >
                    <span style={{ fontFamily: MONO, color: MUTED }}>
                      {call.seq}
                    </span>
                    <span style={{ fontFamily: MONO }}>{call.phase}</span>
                    <span style={{ fontFamily: MONO }}>{call.method}</span>
                    <span
                      title={call.url}
                      style={{
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        fontFamily: MONO,
                        color: '#7aa2f7',
                      }}
                    >
                      {call.url}
                    </span>
                    <span>
                      {call.responseStatus !== null ? (
                        <Badge bg={statusColor.bg} fg={statusColor.fg}>
                          {call.responseStatus}
                        </Badge>
                      ) : (
                        <span style={{ color: FAINT }}>—</span>
                      )}
                    </span>
                    <span style={{ color: MUTED, fontFamily: MONO }}>
                      {call.durationMs !== null ? `${call.durationMs} ms` : '—'}
                    </span>
                    <span>
                      {call.dryRun ? (
                        <Badge
                          bg="#2a2140"
                          fg="#c4b5fd"
                          title="payload constructed and recorded only — never sent"
                        >
                          dry-run
                        </Badge>
                      ) : (
                        <Badge bg="#26262b" fg="#9ca3af">
                          live
                        </Badge>
                      )}
                    </span>
                  </summary>
                  <div style={{ padding: '0 0.5rem 0.75rem 0.5rem' }}>
                    <div
                      style={{
                        fontSize: '0.75rem',
                        color: MUTED,
                        fontFamily: MONO,
                        overflowWrap: 'anywhere',
                        marginBottom: '0.25rem',
                      }}
                    >
                      {call.method} {call.url}
                      {call.createdAt ? ` · ${formatDate(call.createdAt)}` : ''}
                    </div>
                    <JsonDetails
                      label="request headers"
                      value={call.requestHeaders}
                    />
                    <JsonDetails
                      label="request body"
                      value={call.requestBody}
                    />
                    <JsonDetails
                      label="response headers"
                      value={call.responseHeaders}
                    />
                    <JsonDetails
                      label="response body"
                      value={call.responseBody}
                    />
                    {call.requestHeaders == null &&
                    call.requestBody == null &&
                    call.responseHeaders == null &&
                    call.responseBody == null ? (
                      <Empty>
                        no headers or bodies recorded for this call.
                      </Empty>
                    ) : null}
                  </div>
                </details>
              );
            })}
          </div>
        </div>
      )}

      {/* ---- actions ---- */}
      <SectionHeading>actions</SectionHeading>
      {task.state === 'REVIEW' ? (
        <TaskActions taskId={task.id} mode="approve" />
      ) : task.state === 'FAILED' ? (
        <TaskActions taskId={task.id} mode="requeue" />
      ) : task.state === 'NEEDS_INPUT' ? (
        <Empty>
          use “Save answers” / “Save &amp; requeue” in the form above.
        </Empty>
      ) : (
        <Empty>no actions available while the task is in {task.state}.</Empty>
      )}
    </div>
  );
}
