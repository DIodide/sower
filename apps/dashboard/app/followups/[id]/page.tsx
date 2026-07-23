import type { FollowupEvent } from '@sower/core';
import { FOLLOWUP_ALLOWED } from '@sower/core';
import { applicationTasks, events, followups, jobs } from '@sower/db';
import { asc, desc, eq, inArray } from 'drizzle-orm';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { getDb } from '../../../lib/db';
import { toDateInputValue } from '../../../lib/deadline';
import { DueDateControl } from '../../../lib/due-date-control';
import {
  followupEventDetails,
  followupIdOf,
  urlHost,
} from '../../../lib/followups';
import {
  eventLabel,
  formatDeadline,
  isDeadlineSoon,
  relativeTime,
  rowLabel,
} from '../../../lib/format';
import { InlineNote } from '../../../lib/inline-note';
import { Empty, ExpandableText, StateBadge, Timestamp } from '../../../lib/ui';
import { Badge } from '../../tasks/[id]/ui';
import { saveFollowupDueDate, saveFollowupNotes } from '../actions';
import { FollowupKindBadge, FollowupStateBadge } from '../ui';
import { FollowupActions } from './followup-actions';
import { ReassignControl } from './reassign-control';

export const dynamic = 'force-dynamic';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Action-bar display order: forward motion first, then the resolutions. */
const EVENT_ORDER: FollowupEvent[] = [
  'TRIAGE',
  'SCHEDULE',
  'COMPLETE_STEP',
  'REOPEN',
  'RESOLVE',
  'DISMISS',
];

/** States where the due date can still be edited — same idea as the task
 *  page's DUE_EDITABLE_STATES: terminal rows are read-only. */
const DUE_LOCKED_STATES = new Set<string>(['DONE', 'DISMISSED']);

function MetaItem({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div
        className="hint faint"
        style={{ fontSize: '0.6875rem', fontWeight: 600 }}
      >
        {label}
      </div>
      <div style={{ fontSize: '0.875rem', overflowWrap: 'anywhere' }}>
        {children}
      </div>
    </div>
  );
}

/** Keys the timeline already renders as label/badges — not data to repeat. */
const RENDERED_DATA_KEYS = new Set(['followupId', 'event', 'from', 'to']);

/** Leftover event-data fields (an update's changed-field list, an email
 *  subject, …), rendered like the task page's EventData. Primitives show
 *  as-is; a string array (FOLLOWUP_UPDATED's `fields`) joins readably. */
function FollowupEventData({ data }: { data: unknown }) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const shown = Object.entries(data as Record<string, unknown>)
    .filter(([key]) => !RENDERED_DATA_KEYS.has(key))
    .map(([key, value]): [string, string] | null => {
      if (
        value === null ||
        typeof value === 'string' ||
        typeof value === 'number' ||
        typeof value === 'boolean'
      ) {
        return [key, String(value)];
      }
      if (Array.isArray(value) && value.every((v) => typeof v === 'string')) {
        return [key, value.join(', ')];
      }
      return null;
    })
    .filter((entry): entry is [string, string] => entry !== null);
  if (shown.length === 0) return null;
  return (
    <div style={{ marginTop: '0.25rem' }}>
      {shown.map(([key, value]) => (
        <div key={key} style={{ fontSize: '0.8125rem', marginTop: '0.125rem' }}>
          <span className="mono faint">{key}: </span>
          <ExpandableText text={value} max={160} />
        </div>
      ))}
    </div>
  );
}

export default async function FollowupPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (!UUID_RE.test(id)) notFound();

  const db = getDb();

  const followupRows = await db
    .select()
    .from(followups)
    .where(eq(followups.id, id))
    .limit(1);
  const followup = followupRows[0];
  if (!followup) notFound();

  const [taskRows, eventRows, sentRows] = await Promise.all([
    db
      .select({
        id: applicationTasks.id,
        state: applicationTasks.state,
        jobSpec: applicationTasks.jobSpec,
        company: jobs.company,
        title: jobs.title,
        url: jobs.url,
      })
      .from(applicationTasks)
      .leftJoin(jobs, eq(applicationTasks.jobId, jobs.id))
      .where(eq(applicationTasks.id, followup.taskId))
      .limit(1),
    db
      .select()
      .from(events)
      .where(eq(events.taskId, followup.taskId))
      .orderBy(asc(events.createdAt)),
    // Reassign candidates: every sent application (the only tasks a
    // follow-up sensibly belongs to), newest activity first.
    db
      .select({
        id: applicationTasks.id,
        jobSpec: applicationTasks.jobSpec,
        company: jobs.company,
        title: jobs.title,
        url: jobs.url,
      })
      .from(applicationTasks)
      .leftJoin(jobs, eq(applicationTasks.jobId, jobs.id))
      .where(inArray(applicationTasks.state, ['SUBMITTED', 'CONFIRMED']))
      .orderBy(desc(applicationTasks.updatedAt)),
  ]);
  const task = taskRows[0];
  if (!task) notFound();

  // The current task heads the candidate list even when it is no longer in
  // a sent state, so the select always shows where the follow-up is now.
  const candidates = [
    task,
    ...sentRows.filter((row) => row.id !== task.id),
  ].map((row) => ({
    id: row.id,
    label: rowLabel({
      company: row.company,
      title: row.title,
      jobSpec: row.jobSpec,
      url: row.url,
    }),
  }));

  // This follow-up's slice of the parent task's timeline: the events whose
  // data names it (FOLLOWUP_CREATED / FOLLOWUP_STATE / FOLLOWUP_UPDATED).
  const timeline = eventRows.filter((e) => followupIdOf(e.data) === id);

  // Defensive `?? {}`: an unknown state (bad row, future migration) must
  // degrade to "no actions", not 500 the whole page.
  const allowedFromState = FOLLOWUP_ALLOWED[followup.state] ?? {};
  const allowedEvents = EVENT_ORDER.filter(
    (event) => allowedFromState[event] !== undefined,
  );

  const dueEditable = !DUE_LOCKED_STATES.has(followup.state);
  const due = followup.dueDate;

  return (
    <div>
      <p style={{ margin: '0 0 1rem' }}>
        <Link href="/" className="hint">
          ← All applications
        </Link>
      </p>

      {/* ---- header: kind, title, state, the parent application ---- */}
      <header className="card">
        <div className="row" style={{ alignItems: 'baseline' }}>
          <FollowupKindBadge kind={followup.kind} />
          <h1 className="page-title" style={{ margin: 0 }}>
            {followup.title}
          </h1>
          <FollowupStateBadge state={followup.state} />
          {followup.source === 'email' ? (
            <Badge
              tone="neutral"
              title={
                followup.sourceRef
                  ? `created from an email — ${followup.sourceRef}`
                  : 'created from an email'
              }
            >
              via email
            </Badge>
          ) : null}
        </div>
        {/* div, not p: the reassign affordance expands into a form/select,
            which phrasing content cannot legally contain. */}
        <div className="hint" style={{ margin: '0.375rem 0 0' }}>
          for{' '}
          <Link href={`/tasks/${task.id}`}>
            {rowLabel({
              company: task.company,
              title: task.title,
              jobSpec: task.jobSpec,
              url: task.url,
            })}
          </Link>{' '}
          <StateBadge state={task.state} />{' '}
          <ReassignControl
            followupId={followup.id}
            currentTaskId={task.id}
            candidates={candidates}
          />
        </div>

        {/* The user's note — the task header's exact treatment: labeled,
            always editable with instant save, in every state. */}
        <div style={{ marginTop: '0.5rem', maxWidth: '48rem' }}>
          <div
            className="hint faint"
            style={{ fontSize: '0.72rem', fontWeight: 600 }}
          >
            Notes
          </div>
          <div className="well" style={{ padding: '0.375rem 0.625rem' }}>
            <InlineNote
              taskId={followup.id}
              note={followup.notes}
              saveAction={saveFollowupNotes.bind(null, followup.id)}
            />
          </div>
        </div>
      </header>

      {/* ---- actions: every step allowed from here, plus the link ---- */}
      {allowedEvents.length > 0 || followup.url ? (
        <section className="card">
          <div className="row" style={{ alignItems: 'flex-start' }}>
            <FollowupActions
              followupId={followup.id}
              taskId={task.id}
              events={allowedEvents}
            />
            {followup.url ? (
              <a
                className="btn spread"
                href={followup.url}
                target="_blank"
                rel="noopener noreferrer"
                title={followup.url}
              >
                Open {urlHost(followup.url)} ↗
              </a>
            ) : null}
          </div>
        </section>
      ) : null}

      {/* ---- metadata ---- */}
      <section className="card">
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(11rem, 1fr))',
            gap: '0.75rem 1.5rem',
          }}
        >
          <MetaItem label="Due">
            <DueDateControl
              taskId={followup.id}
              variant="cell"
              editable={dueEditable}
              display={
                due
                  ? {
                      label: `${formatDeadline(due)} · ${relativeTime(due)}`,
                      soon: isDeadlineSoon(due),
                      kind: 'user',
                    }
                  : null
              }
              dueDateISO={toDateInputValue(due)}
              fallback={null}
              saveAction={saveFollowupDueDate.bind(null, followup.id)}
            />
          </MetaItem>
          <MetaItem label="Source">
            <span className="mono">{followup.source}</span>
            {followup.sourceRef ? (
              <span
                className="faint truncate"
                style={{ display: 'inline-block', maxWidth: '100%' }}
                title={followup.sourceRef}
              >
                {' '}
                · {followup.sourceRef}
              </span>
            ) : null}
          </MetaItem>
          <MetaItem label="Added">
            <Timestamp value={followup.createdAt} />
          </MetaItem>
          <MetaItem label="Updated">
            <Timestamp value={followup.updatedAt} />
          </MetaItem>
          {followup.calendarEventId ? (
            <MetaItem label="Calendar">
              <span title={followup.calendarEventId}>on your calendar</span>
            </MetaItem>
          ) : null}
        </div>
      </section>

      {/* ---- the email this follow-up was created from, when stored ---- */}
      {followup.sourceBody ? (
        <details className="panel">
          <summary>
            Source email <span className="hint">as received</span>
          </summary>
          <div className="panel-body">
            {/* UNTRUSTED text: rendered ONLY as a React string, never HTML. */}
            <pre className="source-email">{followup.sourceBody}</pre>
          </div>
        </details>
      ) : null}

      {/* ---- history: the parent timeline's slice about this follow-up ---- */}
      <details className="panel">
        <summary>
          Activity{' '}
          <span className="hint">
            {timeline.length} event{timeline.length === 1 ? '' : 's'}
          </span>
        </summary>
        <div className="panel-body">
          {timeline.length === 0 ? (
            <Empty>No events recorded for this follow-up yet.</Empty>
          ) : (
            <ol className="timeline">
              {timeline.map((event) => {
                const details = followupEventDetails(event.data);
                return (
                  <li key={event.id}>
                    <div className="row" style={{ alignItems: 'baseline' }}>
                      <span
                        title={event.type}
                        style={{ fontSize: '0.875rem', fontWeight: 600 }}
                      >
                        {eventLabel(event.type)}
                      </span>
                      {details.from || details.to ? (
                        <span
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: '0.375rem',
                          }}
                        >
                          {details.from ? (
                            <FollowupStateBadge state={details.from} />
                          ) : null}
                          {details.from && details.to ? (
                            <span className="faint">→</span>
                          ) : null}
                          {details.to ? (
                            <FollowupStateBadge state={details.to} />
                          ) : null}
                        </span>
                      ) : null}
                      <span className="hint faint spread">
                        <Timestamp value={event.createdAt} inline />
                      </span>
                    </div>
                    <FollowupEventData data={event.data} />
                  </li>
                );
              })}
            </ol>
          )}
        </div>
      </details>

      <p className="hint faint mono" style={{ marginTop: '1.5rem' }}>
        follow-up {followup.id}
      </p>
    </div>
  );
}
