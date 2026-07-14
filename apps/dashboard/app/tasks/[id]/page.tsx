import type { Question, ResolvedAnswer, TaskState } from '@sower/core';
import type { Document } from '@sower/db';
import {
  apiCalls,
  applicationTasks,
  documents,
  events,
  jobDescriptions,
  jobs,
  type WorkdaySessionRow,
  workdaySessions,
} from '@sower/db';
import { asc, desc, eq } from 'drizzle-orm';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { getDb } from '../../../lib/db';
import { formatLocal, type Tone } from '../../../lib/format';
import {
  Empty,
  ExpandableText,
  SectionHeading,
  StateBadge,
  Timestamp,
} from '../../../lib/ui';
import { JobDescriptionPanel } from './job-description-panel';
import { NeedsInputForm } from './needs-input-form';
import { OtpForm } from './otp-form';
import { documentKind } from './question-kind';
import type { DocumentOption, QuestionView } from './questions-panel';
import { QuestionsPanel } from './questions-panel';
import { TaskActions } from './task-actions';
import { Badge, JsonDetails } from './ui';

export const dynamic = 'force-dynamic';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CALL_GRID_COLUMNS =
  '2.5rem 6.5rem 3.5rem minmax(10rem, 1fr) 3.5rem 5rem 4.5rem';

/** Pipeline positions for the stepper (FAILED/DUPLICATE render no stepper). */
const STEPS: { label: string; states: TaskState[] }[] = [
  { label: 'Ingested', states: ['INGESTED', 'PARSED'] },
  { label: 'Queued', states: ['QUEUED'] },
  { label: 'Processing', states: ['PREPARING', 'FILLING'] },
  { label: 'Your input', states: ['NEEDS_INPUT', 'AWAITING_OTP'] },
  { label: 'Review', states: ['REVIEW'] },
  { label: 'Submitted', states: ['SUBMITTED', 'CONFIRMED'] },
];

function MetaItem({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div
        className="hint faint"
        style={{ fontSize: '0.72rem', fontWeight: 800 }}
      >
        {label}
      </div>
      <div style={{ fontSize: '0.875rem', overflowWrap: 'anywhere' }}>
        {children}
      </div>
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
        <div key={key} style={{ fontSize: '0.8125rem', marginTop: '0.125rem' }}>
          <span className="mono faint">{key}: </span>
          <ExpandableText text={String(value)} max={160} />
        </div>
      ))}
      {primitives.length !== entries.length ? (
        <JsonDetails label="full event data" value={data} />
      ) : null}
    </div>
  );
}

function httpStatusTone(status: number | null): Tone {
  if (status === null) return 'neutral';
  if (status >= 200 && status < 300) return 'success';
  if (status >= 400) return 'danger';
  return 'attention';
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
      ...(question.conditional ? { conditional: true } : {}),
      ...(question.help ? { help: question.help } : {}),
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

/** The "what happens next" strip: one glance = the task's current ask. */
function NextStep({
  task,
  requiredMissing,
  optionalMissing,
  needsSession,
  session,
  tenant,
}: {
  task: { id: string; state: string; lastError: string | null };
  requiredMissing: number;
  optionalMissing: number;
  /** Workday task parked account-required (a session must be captured first). */
  needsSession?: boolean;
  session?: WorkdaySessionRow;
  tenant?: string | null;
}) {
  switch (task.state) {
    case 'NEEDS_INPUT': {
      // Workday-before-a-session: a capture banner, not an answer-questions one.
      if (needsSession) {
        const status = session?.status;
        if (status === 'requested' || status === 'capturing') {
          return (
            <div className="banner banner--progress">
              <p>
                <strong>
                  {status === 'capturing'
                    ? 'Capturing now.'
                    : 'Session capture requested.'}
                </strong>{' '}
                {status === 'capturing'
                  ? 'Complete the sign-in in the browser window that opened on your machine.'
                  : `The local agent will open a browser on your machine to sign in to ${tenant ?? 'this tenant'}. If nothing opens, make sure the agent is running (see the Sessions tab).`}
              </p>
            </div>
          );
        }
        return (
          <div className="banner banner--attention">
            <div style={{ flex: '1 1 20rem' }}>
              <p style={{ marginBottom: '0.625rem' }}>
                <strong>
                  This Workday job needs a browser session for{' '}
                  {tenant ?? 'its tenant'}.
                </strong>{' '}
                Start a capture — the local agent opens a Chrome window on your
                machine; sign in there and the task advances automatically.
                {status === 'failed' && session?.error ? (
                  <>
                    {' '}
                    Last attempt failed:{' '}
                    <span className="mono">{session.error}</span>
                  </>
                ) : null}
              </p>
              <TaskActions taskId={task.id} mode="start" />
            </div>
          </div>
        );
      }
      const summary =
        requiredMissing > 0
          ? `${requiredMissing} required question${requiredMissing === 1 ? '' : 's'} need${requiredMissing === 1 ? 's' : ''} your answer` +
            (optionalMissing > 0 ? ` (plus ${optionalMissing} optional)` : '')
          : optionalMissing > 0
            ? `${optionalMissing} optional question${optionalMissing === 1 ? '' : 's'} remain — or just re-run it`
            : 'Nothing could be auto-resolved yet — re-run once your profile or answer library covers it';
      return (
        <div className="banner banner--attention">
          <p>
            <strong>Waiting on you.</strong> {summary}.
          </p>
          <a href="#answers" className="btn btn--primary btn--sm spread">
            Answer questions ↓
          </a>
        </div>
      );
    }
    case 'REVIEW':
      return (
        <div className="banner banner--attention">
          <div style={{ flex: '1 1 20rem' }}>
            <p style={{ marginBottom: '0.625rem' }}>
              <strong>Ready for your review.</strong> Every required question is
              answered — skim the answers below, then approve. Approval runs a{' '}
              <strong>dry-run</strong> only: the payload is constructed and
              recorded, nothing is sent to the platform.
            </p>
            <TaskActions taskId={task.id} mode="approve" />
          </div>
        </div>
      );
    case 'FAILED':
      return (
        <div className="banner banner--danger">
          <div style={{ flex: '1 1 20rem' }}>
            <p
              style={{ marginBottom: task.lastError ? '0.375rem' : '0.625rem' }}
            >
              <strong>Processing failed.</strong>
            </p>
            {task.lastError ? (
              <p
                className="mono"
                style={{ fontSize: '0.8125rem', marginBottom: '0.625rem' }}
              >
                <ExpandableText text={task.lastError} max={160} />
              </p>
            ) : null}
            <TaskActions taskId={task.id} mode="requeue" />
          </div>
        </div>
      );
    case 'AWAITING_OTP':
      return (
        <div className="banner banner--attention">
          <p>
            <strong>Waiting on a one-time passcode.</strong> The platform sent a
            verification code that has to be entered before this can move on.
            Enter it here or via the Discord card.
          </p>
          <div style={{ marginTop: '0.75rem' }}>
            <OtpForm taskId={task.id} />
          </div>
        </div>
      );
    case 'SUBMITTED':
    case 'CONFIRMED':
      return (
        <div className="banner banner--success">
          <p>
            <strong>
              {task.state === 'CONFIRMED' ? 'Confirmed.' : 'Submitted.'}
            </strong>{' '}
            Nothing left to do here — the full payload and history are below.
          </p>
        </div>
      );
    case 'DUPLICATE':
      return (
        <div className="banner banner--neutral">
          <p>
            <strong>Duplicate.</strong> This job was already ingested as another
            task, so this one is parked.
          </p>
        </div>
      );
    default:
      return (
        <div className="banner banner--progress">
          <p>
            <strong>In the pipeline.</strong> The worker is on it — nothing for
            you to do right now.
          </p>
        </div>
      );
  }
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

  const [jobRows, eventRows, callRows, documentRows, descriptionRows] =
    await Promise.all([
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
      // Newest description version first; row [0] is the current one and the
      // array length is the total number of stored versions for this job.
      db
        .select()
        .from(jobDescriptions)
        .where(eq(jobDescriptions.jobId, task.jobId))
        .orderBy(desc(jobDescriptions.version)),
    ]);
  const job = jobRows[0];
  const latestDescription = descriptionRows[0];

  const spec = task.jobSpec;
  const resolution = task.resolution;
  // Workday parks account-required until a browser session is captured; that
  // NEEDS_INPUT is a "capture a session" state, not an "answer questions" one.
  const needsSession =
    job?.platform === 'workday' && spec?.formAccess === 'account-required';
  const sessionRow =
    needsSession && job?.tenant
      ? (
          await db
            .select()
            .from(workdaySessions)
            .where(eq(workdaySessions.tenant, job.tenant))
            .limit(1)
        )[0]
      : undefined;
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
    createdLabel: formatLocal(d.createdAt),
  }));
  const resolvedCount = views.filter((v) => v.status === 'resolved').length;
  const missingViews = views.filter((v) => v.status === 'missing');
  const requiredMissing = missingViews.filter((v) => v.required).length;
  const optionalMissing = missingViews.length - requiredMissing;

  const stepIndex = STEPS.findIndex((s) =>
    (s.states as string[]).includes(task.state),
  );

  return (
    <div>
      <p style={{ margin: '0 0 1rem' }}>
        <Link href="/" className="hint">
          ← All applications
        </Link>
      </p>

      {/* ---- header ---- */}
      <header className="card">
        <div className="row" style={{ alignItems: 'baseline' }}>
          <h1 className="page-title" style={{ margin: 0 }}>
            {job?.company ?? '—'}{' '}
            <span
              style={{
                color: 'var(--ink-muted)',
                fontWeight: 600,
                fontSize: '1.125rem',
              }}
            >
              — {job?.title ?? 'untitled role'}
            </span>
          </h1>
          <StateBadge state={task.state} />
          {task.attempt > 0 ? (
            <span className="q-meta">attempt {task.attempt}</span>
          ) : null}
        </div>

        {stepIndex >= 0 ? (
          <ol className="steps">
            {STEPS.map((step, i) => (
              <li
                key={step.label}
                className={
                  i < stepIndex ? 'done' : i === stepIndex ? 'current' : ''
                }
                aria-current={i === stepIndex ? 'step' : undefined}
              >
                {step.label}
              </li>
            ))}
          </ol>
        ) : null}

        <hr className="divider-soft" />
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(11rem, 1fr))',
            gap: '0.75rem 1.5rem',
          }}
        >
          <MetaItem label="Platform">
            {job ? (
              <Link
                href={`/platforms/${encodeURIComponent(job.platform)}`}
                className="mono"
              >
                {job.platform}
              </Link>
            ) : (
              '—'
            )}
          </MetaItem>
          <MetaItem label="Tenant">
            {job?.tenant ? (
              <Link
                href={`/tenants/${encodeURIComponent(job.platform)}/${encodeURIComponent(job.tenant)}`}
                className="mono"
              >
                {job.tenant}
              </Link>
            ) : (
              '—'
            )}
          </MetaItem>
          <MetaItem label="Posting">
            {job?.url ? (
              <a
                href={job.url}
                target="_blank"
                rel="noopener noreferrer"
                className="truncate"
                style={{ display: 'inline-block', maxWidth: '100%' }}
                title={job.url}
              >
                {job.url.replace(/^https?:\/\//, '')} ↗
              </a>
            ) : (
              '—'
            )}
          </MetaItem>
          <MetaItem label="Source">{job?.source ?? '—'}</MetaItem>
          <MetaItem label="Added">
            <Timestamp value={task.createdAt} inline />
          </MetaItem>
          <MetaItem label="Updated">
            <Timestamp value={task.updatedAt} inline />
          </MetaItem>
          {job?.terms && job.terms.length > 0 ? (
            <MetaItem label="Terms">
              <span
                style={{
                  display: 'inline-flex',
                  gap: '0.375rem',
                  flexWrap: 'wrap',
                }}
              >
                {job.terms.map((term) => (
                  <Badge key={term} tone="neutral">
                    {term}
                  </Badge>
                ))}
              </span>
            </MetaItem>
          ) : null}
          {task.lastError && task.state !== 'FAILED' ? (
            <div style={{ gridColumn: '1 / -1', minWidth: 0 }}>
              <div
                className="hint faint"
                style={{ fontSize: '0.72rem', fontWeight: 800 }}
              >
                Last error
              </div>
              <div className="status-err" style={{ fontWeight: 600 }}>
                <ExpandableText text={task.lastError} max={160} />
              </div>
            </div>
          ) : null}
        </div>
      </header>

      {/* ---- what's next ---- */}
      <NextStep
        task={task}
        requiredMissing={requiredMissing}
        optionalMissing={optionalMissing}
        needsSession={needsSession}
        session={sessionRow}
        tenant={job?.tenant}
      />

      {/* ---- form & answers ---- */}
      <section id="answers">
        <SectionHeading>Questions &amp; answers</SectionHeading>
        {spec && views.length > 0 ? (
          <div className="row" style={{ margin: '0 0 0.75rem' }}>
            <div className="meter" style={{ maxWidth: '16rem' }}>
              <div
                style={{
                  width: `${Math.round((resolvedCount / views.length) * 100)}%`,
                }}
              />
            </div>
            <span className="hint num">
              {resolvedCount} of {views.length} answered
              {requiredMissing > 0
                ? ` · ${requiredMissing} required remaining`
                : ''}
            </span>
            <span className="hint faint">
              Saved answers come from your profile, documents, and the{' '}
              <Link href="/answers">answer library</Link>.
            </span>
          </div>
        ) : null}
        {!spec ? (
          <Empty>
            No job spec captured yet — the task has not been processed.
          </Empty>
        ) : (
          <div className="card">
            {task.state === 'NEEDS_INPUT' ? (
              <NeedsInputForm
                taskId={task.id}
                views={views}
                documents={documentOptions}
                company={job?.company ?? spec.company ?? ''}
              />
            ) : (
              <QuestionsPanel views={views} />
            )}
          </div>
        )}
      </section>

      {/* ---- secondary: description, history, network ---- */}
      <SectionHeading>Details</SectionHeading>

      {latestDescription ? (
        <JobDescriptionPanel
          content={latestDescription.content}
          version={latestDescription.version}
          fetchedAt={latestDescription.fetchedAt}
          versionCount={descriptionRows.length}
        />
      ) : (
        <Empty>No job description captured for this posting yet.</Empty>
      )}

      <details className="panel">
        <summary>
          Activity{' '}
          <span className="hint">
            {eventRows.length} event{eventRows.length === 1 ? '' : 's'}
          </span>
        </summary>
        <div className="panel-body">
          {eventRows.length === 0 ? (
            <Empty>No events recorded for this task yet.</Empty>
          ) : (
            <ol className="timeline">
              {eventRows.map((event) => (
                <li key={event.id}>
                  <div className="row" style={{ alignItems: 'baseline' }}>
                    <span
                      className="mono"
                      style={{ fontSize: '0.8125rem', fontWeight: 700 }}
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
                          <span className="faint">→</span>
                        ) : null}
                        {event.toState ? (
                          <StateBadge state={event.toState} />
                        ) : null}
                      </span>
                    ) : null}
                    <span className="hint faint spread">
                      <Timestamp value={event.createdAt} inline />
                    </span>
                  </div>
                  <EventData data={event.data} />
                </li>
              ))}
            </ol>
          )}
        </div>
      </details>

      <details className="panel">
        <summary>
          Network log{' '}
          <span className="hint">
            {callRows.length} recorded call{callRows.length === 1 ? '' : 's'} ·
            for debugging
          </span>
        </summary>
        <div className="panel-body">
          {callRows.length === 0 ? (
            <Empty>No api calls recorded for this task yet.</Empty>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <div style={{ minWidth: '42rem' }}>
                <div
                  className="mono faint"
                  style={{
                    display: 'grid',
                    gridTemplateColumns: CALL_GRID_COLUMNS,
                    gap: '0.5rem',
                    padding: '0.375rem 0.5rem',
                    fontSize: '0.72rem',
                    fontWeight: 700,
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
                {callRows.map((call) => (
                  <details
                    key={call.id}
                    style={{
                      borderTop: '1px solid rgba(80, 92, 150, 0.1)',
                    }}
                  >
                    <summary
                      style={{
                        display: 'grid',
                        gridTemplateColumns: CALL_GRID_COLUMNS,
                        gap: '0.5rem',
                        alignItems: 'baseline',
                        padding: '0.5rem',
                        cursor: 'pointer',
                        fontSize: '0.8125rem',
                        listStyle: 'none',
                      }}
                    >
                      <span className="mono faint">{call.seq}</span>
                      <span className="mono">{call.phase}</span>
                      <span className="mono">{call.method}</span>
                      <span
                        title={call.url}
                        className="mono truncate"
                        style={{ color: 'var(--accent-deep)' }}
                      >
                        {call.url}
                      </span>
                      <span>
                        {call.responseStatus !== null ? (
                          <Badge tone={httpStatusTone(call.responseStatus)}>
                            {call.responseStatus}
                          </Badge>
                        ) : (
                          <span className="faint">—</span>
                        )}
                      </span>
                      <span className="mono faint">
                        {call.durationMs !== null
                          ? `${call.durationMs} ms`
                          : '—'}
                      </span>
                      <span>
                        {call.dryRun ? (
                          <Badge
                            tone="accent"
                            title="payload constructed and recorded only — never sent"
                          >
                            dry-run
                          </Badge>
                        ) : (
                          <Badge tone="neutral">live</Badge>
                        )}
                      </span>
                    </summary>
                    <div style={{ padding: '0 0.5rem 0.75rem 0.5rem' }}>
                      <div
                        className="mono faint"
                        style={{
                          fontSize: '0.78rem',
                          overflowWrap: 'anywhere',
                          marginBottom: '0.25rem',
                        }}
                      >
                        {call.method} {call.url}
                        {call.createdAt
                          ? ` · ${formatLocal(call.createdAt)}`
                          : ''}
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
                          No headers or bodies recorded for this call.
                        </Empty>
                      ) : null}
                    </div>
                  </details>
                ))}
              </div>
            </div>
          )}
        </div>
      </details>

      <p className="hint faint mono" style={{ marginTop: '1.5rem' }}>
        task {task.id}
      </p>
    </div>
  );
}
