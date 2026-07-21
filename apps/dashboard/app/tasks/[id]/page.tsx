import type { BankEntry, BankValue } from '@sower/answers';
import {
  isBankOptionValue,
  matchStoredOption,
  normalizeCompanyKey,
  selectBankValue,
} from '@sower/answers';
import type { Question, ResolvedAnswer, TaskState } from '@sower/core';
import type { Document } from '@sower/db';
import {
  answers,
  apiCalls,
  applicationTasks,
  documents,
  events,
  followups,
  investigationRuns,
  jobDescriptions,
  jobs,
  type WorkdaySessionRow,
  workdaySessions,
} from '@sower/db';
import { asc, desc, eq, sql } from 'drizzle-orm';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { getDb } from '../../../lib/db';
import { pickDeadline, toDateInputValue } from '../../../lib/deadline';
import { DueDateControl } from '../../../lib/due-date-control';
import {
  eventLabel,
  formatDeadline,
  formatLocal,
  isDeadlineSoon,
  PRIORITY_LOCKED,
  relativeTime,
  SECTIONS,
  type Tone,
} from '../../../lib/format';
import { InlineNote } from '../../../lib/inline-note';
import { PriorityControl } from '../../../lib/priority-control';
import {
  Empty,
  ExpandableText,
  SectionHeading,
  StateBadge,
  Timestamp,
} from '../../../lib/ui';
import { FollowupsPanel } from './followups-panel';
import { InvestigationPanel } from './investigation-panel';
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

/** States where the user can still set their own due date (the same rows the
 *  home page makes the ⏰ chip interactive on: waiting + incoming). */
const DUE_EDITABLE_STATES = new Set<string>([
  'INGESTED',
  'PARSED',
  'QUEUED',
  'PREPARING',
  'FILLING',
  'NEEDS_INPUT',
  'REVIEW',
  'AWAITING_OTP',
]);

/** Pipeline positions for the stepper (FAILED/DUPLICATE render no stepper),
 *  labeled with the same section vocabulary the rows and messages use.
 *  FILLING is only ever reached AFTER an approval (REVIEW → APPROVED) or an
 *  OTP resume, so it shares Review's visual step — the stepper never walks
 *  backward the moment the user approves. */
const STEPS: { label: string; states: TaskState[] }[] = [
  { label: 'Added', states: ['INGESTED', 'PARSED'] },
  { label: 'Queued', states: ['QUEUED'] },
  { label: 'Processing', states: ['PREPARING'] },
  { label: SECTIONS.waiting, states: ['NEEDS_INPUT', 'AWAITING_OTP'] },
  { label: 'Your review', states: ['REVIEW', 'FILLING'] },
  { label: SECTIONS.sent, states: ['SUBMITTED', 'CONFIRMED'] },
];

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

/**
 * The 'saved' view for a question the stored resolution still lists as
 * missing but whose answer already exists in the answers bank (typically
 * saved moments ago from this very page — async reprocessing has not
 * refreshed the resolution yet). Display and prefill use the SAME matching
 * the resolver will use on the next run (matchStoredOption), so what this
 * shows is exactly what will be filled in. Returns null when the bank value
 * cannot apply here (stale doc pick, array into a text field) — the
 * question then stays truly missing.
 */
function buildSavedView(
  base: Omit<QuestionView, 'status'>,
  question: Question,
  saved: BankValue,
  docByPath: Map<string, Document>,
): QuestionView | null {
  if (question.type === 'file') {
    // Doc picks store the chosen document's storagePath (a string).
    if (typeof saved !== 'string') return null;
    const doc = docByPath.get(saved);
    if (!doc) return null;
    return {
      ...base,
      status: 'saved',
      savedValues: [`${doc.filename} (${doc.kind})`],
      savedDocId: doc.id,
    };
  }

  if (question.type === 'select' || question.type === 'multiselect') {
    const items = Array.isArray(saved) ? saved : [saved];
    if (items.length === 0) return null;
    const display: string[] = [];
    const input: string[] = [];
    for (const item of items) {
      if (typeof item === 'object' && !isBankOptionValue(item)) return null;
      const option = matchStoredOption(item, question.options ?? []);
      // Prefill only options that exist on THIS form; the display still
      // shows the saved label even when the option ids differ (old-shape
      // cross-tenant rows).
      if (option !== undefined) input.push(String(option.value));
      display.push(
        option?.label ?? (isBankOptionValue(item) ? item.label : String(item)),
      );
    }
    return {
      ...base,
      status: 'saved',
      savedValues: display,
      savedInput: input,
    };
  }

  // text / textarea — mirrors the resolver: arrays never fill a text field;
  // a {value,label} select answer contributes its human label.
  if (Array.isArray(saved)) return null;
  const text = isBankOptionValue(saved) ? saved.label : String(saved);
  return { ...base, status: 'saved', savedValues: [text], savedInput: [text] };
}

function buildQuestionViews(
  questions: Question[],
  resolved: ResolvedAnswer[],
  missing: Question[],
  hasResolution: boolean,
  docByPath: Map<string, Document>,
  bank: BankEntry[],
  companyKey: string,
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

    if (!hasResolution || !missingIds.has(question.id)) {
      return { ...base, status: 'unknown' as const };
    }
    // The stored resolution says 'missing', but the answers bank may already
    // hold a matching answer — surface it as 'saved' so a save visibly
    // sticks immediately instead of the inputs re-rendering empty.
    const banked = selectBankValue(question, bank, companyKey);
    if (banked !== undefined) {
      const savedView = buildSavedView(base, question, banked, docByPath);
      if (savedView !== null) return savedView;
    }
    return { ...base, status: 'missing' as const };
  });
}

/** The "what happens next" strip: one glance = the task's current ask. */
function NextStep({
  task,
  requiredMissing,
  optionalMissing,
  savedCount,
  needsSession,
  session,
  tenant,
  discard,
  canUnmark,
  unsupported,
  investigationRunning,
  listing,
}: {
  task: { id: string; state: string; lastError: string | null };
  requiredMissing: number;
  optionalMissing: number;
  /** Bank answers saved but not applied yet (they fill in on the next run). */
  savedCount: number;
  /** Workday task parked account-required (a session must be captured first). */
  needsSession?: boolean;
  session?: WorkdaySessionRow;
  tenant?: string | null;
  /** The latest DISCARD event: was it the auto rule, and its "why" note
   *  (DISCARDED tasks only). */
  discard?: { auto: boolean; note: string | null } | null;
  /** SUBMITTED via an out-of-band "Mark applied" — offer the undo. */
  canUnmark?: boolean;
  /** NEEDS_INPUT on an unknown platform with NO spec: no adapter can read
   *  the form, and re-running would change nothing — the honest asks are
   *  the browser agent or a discard. */
  unsupported?: boolean;
  /** The latest investigation run is still going. */
  investigationRunning?: boolean;
  /** The page turned out to be a jobs LISTING whose links were expanded
   *  into individual queue tasks (N added) — Investigate is demoted. */
  listing?: { added: number } | null;
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
                {status === 'capturing' ? (
                  'Complete the sign-in in the browser window that opened on your machine.'
                ) : (
                  <>
                    The local agent will open a browser on your machine to sign
                    in to {tenant ?? 'this tenant'}. If nothing opens, check
                    that the agent is alive under{' '}
                    <Link href="/system#sessions">
                      System → Local agent &amp; sessions
                    </Link>
                    .
                  </>
                )}
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
      // Unsupported site with no discovered form: "answer questions" and
      // "re-run once your profile covers it" would both be lies — there is
      // no form to fill. The honest asks: run the browser agent, or discard.
      if (unsupported) {
        // The page was a jobs LISTING and its links were already expanded
        // into individual tasks: the honest next step is those tasks, not
        // another investigation (which would only re-find the listing).
        if (listing) {
          return (
            <div className="banner banner--neutral">
              <p>
                <strong>This is a listings page</strong> — {listing.added}{' '}
                individual job{listing.added === 1 ? ' was' : 's were'} added to
                your queue.{' '}
                <Link href="/">See them on the applications list</Link>. There
                is no single application to fill on this page itself — discard
                it once you no longer need the reference.
              </p>
            </div>
          );
        }
        if (investigationRunning) {
          return (
            <div className="banner banner--progress">
              <p>
                <strong>Browser agent running.</strong> It is discovering the
                application form on this unsupported site now — results land on
                this task.
              </p>
            </div>
          );
        }
        return (
          <div className="banner banner--attention">
            <div style={{ flex: '1 1 20rem' }}>
              <p style={{ marginBottom: '0.625rem' }}>
                <strong>Unsupported site.</strong> sower has no adapter for this
                platform, so it cannot read or fill the application form itself.
                Run the browser agent to discover the application form, or
                discard the task.
              </p>
              <TaskActions taskId={task.id} mode="investigate" />
            </div>
          </div>
        );
      }
      const summary =
        requiredMissing > 0
          ? `${requiredMissing} required question${requiredMissing === 1 ? '' : 's'} need${requiredMissing === 1 ? 's' : ''} your answer` +
            (optionalMissing > 0 ? ` (plus ${optionalMissing} optional)` : '')
          : savedCount > 0
            ? `${savedCount} saved answer${savedCount === 1 ? ' is' : 's are'} ready — re-run the application to apply ${savedCount === 1 ? 'it' : 'them'}` +
              (optionalMissing > 0
                ? ` (${optionalMissing} optional question${optionalMissing === 1 ? '' : 's'} remain)`
                : '')
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
          <div style={{ flex: '1 1 20rem' }}>
            <p style={{ marginBottom: canUnmark ? '0.625rem' : 0 }}>
              <strong>
                {task.state === 'CONFIRMED' ? 'Confirmed.' : 'Submitted.'}
              </strong>{' '}
              Nothing left to do here — the full payload and history are below.
            </p>
            {/* Out-of-band marks only: an application sower actually
                submitted can never be un-marked (the api enforces it too). */}
            {canUnmark ? (
              <TaskActions taskId={task.id} mode="unmark-applied" />
            ) : null}
          </div>
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
    case 'DISCARDED':
      // The auto rule (e.g. full-time postings while hunting internships, or
      // a listings page expanded into individual tasks) gets its own phrasing
      // plus a Restore action — a human never chose this, so the banner
      // invites overriding it. A listing's note ("listing (N jobs added)")
      // additionally points at the queue: the individual jobs ARE the work
      // now, this page never held an application of its own.
      if (discard?.auto) {
        const listingNote = discard.note?.startsWith('listing') ?? false;
        return (
          <div className="banner banner--neutral">
            <div style={{ flex: '1 1 20rem' }}>
              <p style={{ marginBottom: '0.625rem' }}>
                <strong>Auto discarded</strong>
                {discard.note ? <> — {discard.note}</> : null}.{' '}
                {listingNote ? (
                  <>
                    The individual jobs are in <Link href="/">your queue</Link>.{' '}
                  </>
                ) : null}
                Restore it if this rule got it wrong — or re-ingest it to reset
                this same task and run it through ingestion again from scratch.
              </p>
              <div className="row" style={{ alignItems: 'flex-start' }}>
                <TaskActions taskId={task.id} mode="restore" />
                <TaskActions taskId={task.id} mode="reingest" />
              </div>
            </div>
          </div>
        );
      }
      return (
        <div className="banner banner--neutral">
          <div style={{ flex: '1 1 20rem' }}>
            <p style={{ marginBottom: '0.625rem' }}>
              <strong>Discarded</strong>
              {discard?.note ? <> — {discard.note}</> : null}. Moved to the
              Archive; the record and history are kept below. Restore it to pick
              this application back up — or re-ingest it to reset this same task
              and run it through ingestion again from scratch.
            </p>
            <div className="row" style={{ alignItems: 'flex-start' }}>
              <TaskActions taskId={task.id} mode="restore" />
              <TaskActions taskId={task.id} mode="reingest" />
            </div>
          </div>
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

  const [
    jobRows,
    eventRows,
    callRows,
    documentRows,
    descriptionRows,
    investigationRows,
    bankAnswerRows,
    followupRows,
  ] = await Promise.all([
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
    // Latest Tier-2 screenshot investigation for this task (none for
    // non-screenshot tasks — the panel simply doesn't render then).
    db
      .select()
      .from(investigationRuns)
      .where(eq(investigationRuns.taskId, id))
      .orderBy(desc(investigationRuns.startedAt))
      .limit(1),
    // The whole answers bank (a small personal dataset — same read as the
    // api's process.ts): lets the page show answers that are saved but not
    // yet applied by a run, with company scoping handled per question.
    db
      .select({
        normalizedLabel: answers.normalizedLabel,
        value: answers.value,
        company: answers.company,
      })
      .from(answers),
    // Post-application follow-ups on this task: due first (nulls last), then
    // newest — the same order the home "In play" section uses.
    db
      .select()
      .from(followups)
      .where(eq(followups.taskId, id))
      .orderBy(
        sql`${followups.dueDate} asc nulls last`,
        desc(followups.createdAt),
      ),
  ]);
  const job = jobRows[0];
  const latestDescription = descriptionRows[0];
  const investigation = investigationRows[0];
  // "Found" runs ingest the real job; link the reader to its queued task.
  const foundTaskRow = investigation?.foundJobId
    ? (
        await db
          .select({ id: applicationTasks.id })
          .from(applicationTasks)
          .where(eq(applicationTasks.jobId, investigation.foundJobId))
          .orderBy(desc(applicationTasks.createdAt))
          .limit(1)
      )[0]
    : undefined;

  const spec = task.jobSpec;
  const resolution = task.resolution;
  // Location cell: "Boston, MA · Hybrid" — the workplace arrangement is
  // appended only when the location string doesn't already say it (never
  // "Remote (US) · Remote"). Either half can stand alone.
  const location = spec?.location?.trim() || null;
  const locationType = spec?.locationType?.trim() || null;
  const locationDisplay = location
    ? locationType &&
      !location.toLowerCase().includes(locationType.toLowerCase())
      ? `${location} · ${locationType}`
      : location
    : locationType;
  // Deadline cell: the USER'S own due date wins over the posting's parsed
  // deadline (jobs column first, then the spec's value for the window before
  // a process run persisted it). Editing sets the USER date only —
  // jobs.deadline is never overwritten.
  const postingDeadline =
    job?.deadline ?? (spec?.deadline ? new Date(spec.deadline) : null);
  const pickedDeadline = pickDeadline(task.dueDate, postingDeadline);
  const postingOnly = pickDeadline(null, postingDeadline);
  const dueEditable = DUE_EDITABLE_STATES.has(task.state);
  // Workday parks account-required until a browser session is captured; that
  // NEEDS_INPUT is a "capture a session" state, not an "answer questions" one.
  const needsSession =
    job?.platform === 'workday' && spec?.formAccess === 'account-required';
  // Unknown platform and no spec (none discovered yet either): no adapter
  // can read the form, so NEEDS_INPUT here means "browser agent or discard",
  // never "answer questions" / "re-run".
  const unsupported =
    task.state === 'NEEDS_INPUT' && job?.platform === 'unknown' && !spec;
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
  // Screenshots captured for THIS job (Discord image-attachment ingest) —
  // rendered up top so a triager immediately sees what was posted.
  const screenshotDocs = documentRows.filter(
    (d) => d.kind === 'screenshot' && d.jobId === task.jobId,
  );
  // Same companyKey derivation and bank shape as the api's process.ts, so the
  // page previews exactly what the resolver will do on the next run.
  const companyKey = normalizeCompanyKey(
    job?.company ?? spec?.company ?? undefined,
  );
  const bankEntries: BankEntry[] = bankAnswerRows.map((row) => ({
    normalizedLabel: row.normalizedLabel,
    value: row.value as BankValue,
    company: row.company,
  }));
  const views = spec
    ? buildQuestionViews(
        spec.questions,
        resolution?.resolved ?? [],
        resolution?.missing ?? [],
        resolution != null,
        docByPath,
        bankEntries,
        companyKey,
      )
    : [];
  const documentOptions: DocumentOption[] = documentRows.map((d) => ({
    id: d.id,
    kind: d.kind,
    filename: d.filename,
    createdLabel: formatLocal(d.createdAt),
  }));
  const resolvedCount = views.filter((v) => v.status === 'resolved').length;
  const savedCount = views.filter((v) => v.status === 'saved').length;
  const missingViews = views.filter((v) => v.status === 'missing');
  const requiredMissing = missingViews.filter((v) => v.required).length;
  const optionalMissing = missingViews.length - requiredMissing;

  const stepIndex = STEPS.findIndex((s) =>
    (s.states as string[]).includes(task.state),
  );

  // The latest DISCARD event, surfaced in the Discarded banner: data.reason
  // 'auto' means the system's rule (not a human) removed it, and the optional
  // note is the "why". Events are ordered ascending, so scan from the end.
  const discard =
    task.state === 'DISCARDED'
      ? (() => {
          const event = [...eventRows]
            .reverse()
            .find((e) => e.type === 'DISCARD');
          const data = event?.data;
          const record =
            data && typeof data === 'object' && !Array.isArray(data)
              ? (data as Record<string, unknown>)
              : undefined;
          const note = record?.note;
          return {
            auto: record?.reason === 'auto',
            note: typeof note === 'string' && note !== '' ? note : null,
          };
        })()
      : null;

  // Listing expansion: the latest form run classified this unsupported page
  // as a LISTING (its result carries the extracted listingLinks) and the
  // links were ingested (ONE LISTING_EXPANDED event with the funnel counts).
  // N = the new tasks the expansion added (queued + recorded-unsupported).
  const listingExpansion = (() => {
    if (!unsupported || !investigation?.result) return null;
    const result = investigation.result;
    if (!('formFound' in result) || !result.listingLinks?.length) return null;
    const event = [...eventRows]
      .reverse()
      .find((e) => e.type === 'LISTING_EXPANDED');
    if (!event) return null;
    const data =
      event.data && typeof event.data === 'object' && !Array.isArray(event.data)
        ? (event.data as Record<string, unknown>)
        : undefined;
    const ingested = typeof data?.ingested === 'number' ? data.ingested : 0;
    const unsupportedCount =
      typeof data?.unsupported === 'number' ? data.unsupported : 0;
    return { added: ingested + unsupportedCount };
  })();

  // "Un-mark applied" gate: SUBMITTED tasks whose latest SUBMITTED-entering
  // event is the out-of-band MARK_SUBMITTED — a real SUBMIT_OK can't be
  // taken back (the api enforces the same rule with a 409). Events are
  // ordered ascending, so scan from the end.
  const canUnmark =
    task.state === 'SUBMITTED' &&
    [...eventRows].reverse().find((e) => e.toState === 'SUBMITTED')?.type ===
      'MARK_SUBMITTED';

  return (
    <div>
      <p style={{ margin: '0 0 1rem' }}>
        <Link href="/" className="hint">
          ← All applications
        </Link>
      </p>

      {/* ---- header: title, the user's note, pipeline position ---- */}
      <header className="card">
        <div className="row" style={{ alignItems: 'baseline' }}>
          <h1 className="page-title" style={{ margin: 0 }}>
            {job?.company ?? '—'}{' '}
            <span
              style={{
                color: 'var(--ink-muted)',
                fontWeight: 400,
                fontSize: '1rem',
              }}
            >
              — {job?.title ?? 'untitled role'}
            </span>
          </h1>
          <StateBadge state={task.state} />
          <PriorityControl
            taskId={task.id}
            priority={task.priority}
            disabled={PRIORITY_LOCKED.has(task.state)}
          />
          {task.attempt > 0 ? (
            <span className="q-meta">attempt {task.attempt}</span>
          ) : null}
        </div>

        {/* The user's own note — the same inline editor the rows use, but
            clearly labeled so it reads as an editable field (a bare ghost
            line proved too subtle here). Notes are annotations: editable in
            EVERY state, including Sent/Archive. */}
        <div style={{ marginTop: '0.5rem', maxWidth: '48rem' }}>
          <div
            className="hint faint"
            style={{ fontSize: '0.72rem', fontWeight: 600 }}
          >
            Notes
          </div>
          <div className="well" style={{ padding: '0.375rem 0.625rem' }}>
            <InlineNote taskId={task.id} note={task.notes} />
          </div>
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
      </header>

      {/* ---- what's next — directly under the title, before the metadata:
           the ask is the first thing after the name. ---- */}
      <NextStep
        task={task}
        requiredMissing={requiredMissing}
        optionalMissing={optionalMissing}
        savedCount={savedCount}
        needsSession={needsSession}
        session={sessionRow}
        tenant={job?.tenant}
        discard={discard}
        canUnmark={canUnmark}
        unsupported={unsupported}
        investigationRunning={investigation?.status === 'running'}
        listing={listingExpansion}
      />

      {/* ---- job & task metadata ---- */}
      <section className="card">
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
          {/* Deadline — the user's own due date (editable while the task is
              actionable) over the posting's parsed value (shown faintly when
              no user date); red-tinted inside 7 days. Absent only when the
              task is no longer actionable AND no date exists. */}
          {dueEditable || pickedDeadline ? (
            <MetaItem label="Deadline">
              <DueDateControl
                taskId={task.id}
                variant="cell"
                editable={dueEditable}
                display={
                  pickedDeadline
                    ? {
                        label: `${formatDeadline(pickedDeadline.date)} · ${relativeTime(pickedDeadline.date)}`,
                        soon: isDeadlineSoon(pickedDeadline.date),
                        kind: pickedDeadline.kind,
                      }
                    : null
                }
                dueDateISO={toDateInputValue(task.dueDate)}
                fallback={
                  postingOnly
                    ? {
                        label: `${formatDeadline(postingOnly.date)} · ${relativeTime(postingOnly.date)}`,
                        soon: isDeadlineSoon(postingOnly.date),
                      }
                    : null
                }
              />
            </MetaItem>
          ) : null}
          {/* Job facts from the spec — absent fields render no cell at all. */}
          {spec?.employmentType ? (
            <MetaItem label="Type">{spec.employmentType}</MetaItem>
          ) : null}
          {locationDisplay ? (
            <MetaItem label="Location">{locationDisplay}</MetaItem>
          ) : null}
          {spec?.department ? (
            <MetaItem label="Department">{spec.department}</MetaItem>
          ) : null}
          {spec?.compensation ? (
            <MetaItem label="Compensation">{spec.compensation}</MetaItem>
          ) : null}
          <MetaItem label="Added">
            <Timestamp value={task.createdAt} />
          </MetaItem>
          <MetaItem label="Updated">
            <Timestamp value={task.updatedAt} />
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
                style={{ fontSize: '0.6875rem', fontWeight: 600 }}
              >
                Last error
              </div>
              <div className="status-err">
                <ExpandableText text={task.lastError} max={160} />
              </div>
            </div>
          ) : null}
        </div>

        {/* ---- action row: mark applied + discard + re-ingest (hidden once
             sent or already discarded — the DISCARDED banner carries its own
             Re-ingest next to Restore; DUPLICATE keeps discard + re-ingest).
             Both note inputs reveal after the first click (two-step
             confirm). ---- */}
        {!['SUBMITTED', 'CONFIRMED', 'DISCARDED'].includes(task.state) ? (
          <>
            <hr className="divider-soft" />
            <div className="row" style={{ alignItems: 'flex-start' }}>
              {task.state !== 'DUPLICATE' ? (
                <TaskActions taskId={task.id} mode="mark-applied" />
              ) : null}
              <TaskActions taskId={task.id} mode="discard" />
              <TaskActions taskId={task.id} mode="reingest" />
            </div>
          </>
        ) : null}
      </section>

      {/* ---- post-application follow-ups: ALWAYS on sent tasks (the panel
           invites tracking the first reply), and on any task that already
           has some (they survive an un-mark back into the queue). ---- */}
      {['SUBMITTED', 'CONFIRMED'].includes(task.state) ||
      followupRows.length > 0 ? (
        <FollowupsPanel taskId={task.id} rows={followupRows} />
      ) : null}

      {/* ---- job description — up top, right under the ask: it's what the
           user reads while answering. Collapsible; open by default for
           NEEDS_INPUT/REVIEW (defaultOpen). ---- */}
      {latestDescription ? (
        <JobDescriptionPanel
          content={latestDescription.content}
          version={latestDescription.version}
          fetchedAt={latestDescription.fetchedAt}
          versionCount={descriptionRows.length}
          defaultOpen={task.state === 'NEEDS_INPUT' || task.state === 'REVIEW'}
        />
      ) : (
        <Empty>No job description captured for this posting yet.</Empty>
      )}

      {/* ---- ingested screenshots (manual triage source) ---- */}
      {screenshotDocs.length > 0 ? (
        <section>
          <SectionHeading>
            Screenshot{screenshotDocs.length === 1 ? '' : 's'}
          </SectionHeading>
          <div className="card">
            <p className="hint" style={{ margin: '0 0 0.75rem' }}>
              Posted to the ingest channel as an image — read the posting
              details from it to triage this task.
            </p>
            {screenshotDocs.map((doc) => (
              <figure key={doc.id} style={{ margin: '0 0 1rem' }}>
                {/* biome-ignore lint/performance/noImgElement: served by our
                    own IAP-gated /documents route; next/image optimization
                    would re-proxy a private, DB-authorized byte stream. */}
                <img
                  src={`/documents/${doc.id}`}
                  alt={doc.filename}
                  style={{ maxWidth: '100%' }}
                />
                <figcaption
                  className="hint mono"
                  style={{ marginTop: '0.25rem' }}
                >
                  {doc.filename}
                  {doc.createdAt ? ` · ${formatLocal(doc.createdAt)}` : ''}
                </figcaption>
              </figure>
            ))}
          </div>
        </section>
      ) : null}

      {/* ---- form & answers ---- */}
      <section id="answers">
        <SectionHeading>Questions &amp; answers</SectionHeading>
        {spec?.discoveredByAgent ? (
          spec.formVerified ? (
            <div className="banner banner--success">
              <p>
                <Badge tone="success">✓ Form verified</Badge> A human checked
                these machine-extracted questions against the real application
                form. Nothing is ever auto-submitted for this task.
              </p>
            </div>
          ) : task.state === 'DISCARDED' ? null : (
            <div className="banner banner--attention">
              <div style={{ flex: '1 1 20rem' }}>
                <p style={{ marginBottom: '0.625rem' }}>
                  <strong>Form discovered by agent — verify before use.</strong>{' '}
                  These questions were machine-extracted from{' '}
                  {spec.applyUrl ? (
                    <a
                      href={spec.applyUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      the application page
                    </a>
                  ) : (
                    'the application page'
                  )}{' '}
                  of an unsupported platform. Check them against the real form —
                  labels, options, or required flags may be off, and nothing is
                  ever auto-submitted for this task. Once you have compared
                  every field, confirm it here (this also updates the Discord
                  ingest reply):
                </p>
                <TaskActions taskId={task.id} mode="verify" />
              </div>
            </div>
          )
        ) : null}
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
              {savedCount > 0 ? ` · ${savedCount} saved for the next run` : ''}
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

      {/* ---- secondary: history, network ---- */}
      <SectionHeading>Details</SectionHeading>

      {/* Agent investigation lives in Details, collapsed by default — the
          transcript is observability, not workflow, and it dominated the page
          when rendered open up top. The summary line carries the verdict. */}
      {investigation ? (
        <details className="panel">
          <summary>
            Agent investigation{' '}
            <span className="hint">
              {investigation.status === 'running'
                ? 'running…'
                : investigation.status === 'found'
                  ? 'form found'
                  : investigation.status === 'not_found'
                    ? 'no form found'
                    : investigation.status}
              {' · '}
              <Timestamp value={investigation.startedAt} inline />
            </span>
          </summary>
          <div className="panel-body">
            <InvestigationPanel
              run={investigation}
              foundTaskId={foundTaskRow?.id ?? null}
            />
          </div>
        </details>
      ) : null}

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
                      title={event.type}
                      style={{ fontSize: '0.875rem', fontWeight: 600 }}
                    >
                      {eventLabel(event.type)}
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
                    fontSize: '0.6875rem',
                    fontWeight: 600,
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
                    style={{ borderTop: '1px solid var(--line)' }}
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
