import {
  type BankEntry,
  type BankValue,
  isBankOptionValue,
  matchStoredOption,
  selectBankValue,
} from '@sower/answers';
import {
  FOLLOWUP_KIND_LABELS,
  FOLLOWUP_STATE_LABELS,
  type FollowupKind,
  type FollowupState,
  type JobSpec,
  type Question,
  type ResolutionResult,
  type ResolvedAnswer,
  TASK_PRIORITY_LABELS,
  type TaskPriority,
  type TaskState,
} from '@sower/core';
import { applicationTasks, jobs } from '@sower/db';

/**
 * Shared READ-ONLY response shaping for the api's client surfaces: the
 * /mobile routes (iPhone app) and the /cli routes (the sower CLI agents
 * drive). Pure functions over already-fetched rows — no queries live here.
 * The shapes stay in lock-step with the dashboard pages they mirror:
 * - identity fallback: jobs row → jobSpec → URL host (lib/format rowLabel),
 *   returned as separate company/title pieces, never a pre-joined label
 * - effective deadline: the user's due_date wins over jobs.deadline
 *   (lib/deadline pickDeadline — the home page rows' precedence)
 * - question statuses mirror the dashboard's buildQuestionViews: on top of
 *   resolved/missing/unresolved, a SavedContext (the /cli routes) surfaces
 *   'saved' for answers that already exist in the answers bank but have not
 *   been applied by a run yet — exactly what the task page shows
 */

/** Timeline entries returned by a task detail — newest first. */
export const TIMELINE_CAP = 20;

export interface TaskCard {
  id: string;
  company: string | null;
  title: string | null;
  state: TaskState;
  priority: TaskPriority;
  priorityLabel: string;
  dueDate: string | null;
  url: string | null;
  openFollowups: number;
}

export interface FollowupCard {
  id: string;
  taskId: string;
  kind: FollowupKind;
  kindLabel: string;
  title: string;
  state: FollowupState;
  stateLabel: string;
  dueDate: string | null;
  company: string | null;
}

/** ISO string for a (possibly invalid) stored date; invalid = absent. */
export function isoOrNull(value: Date | null | undefined): string | null {
  if (!value || Number.isNaN(value.getTime())) {
    return null;
  }
  return value.toISOString();
}

/** Hostname (www. stripped) — the identity of last resort. */
function urlHost(url: string | null): string | null {
  if (!url) {
    return null;
  }
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

/**
 * The dashboard's rowLabel fallback (jobs row → jobSpec → URL host), kept as
 * separate pieces: the client composes its own label.
 */
export function taskIdentity(row: {
  company: string | null;
  title: string | null;
  jobSpec: JobSpec | null;
  url: string | null;
}): { company: string | null; title: string | null } {
  const company = row.company || row.jobSpec?.company || null;
  const title = row.title || row.jobSpec?.title || null;
  if (company || title) {
    return { company, title };
  }
  return { company: urlHost(row.url), title: null };
}

/** The columns a TaskCard is built from (task + joined job). */
export const cardSelection = {
  id: applicationTasks.id,
  state: applicationTasks.state,
  priority: applicationTasks.priority,
  dueDate: applicationTasks.dueDate,
  jobSpec: applicationTasks.jobSpec,
  company: jobs.company,
  title: jobs.title,
  url: jobs.url,
  deadline: jobs.deadline,
};

export interface CardRow {
  id: string;
  state: TaskState;
  priority: TaskPriority;
  dueDate: Date | null;
  jobSpec: JobSpec | null;
  company: string | null;
  title: string | null;
  url: string | null;
  deadline: Date | null;
}

export function taskCard(
  row: CardRow,
  openByTask: Map<string, number>,
): TaskCard {
  const identity = taskIdentity(row);
  return {
    id: row.id,
    company: identity.company,
    title: identity.title,
    state: row.state,
    priority: row.priority,
    priorityLabel: TASK_PRIORITY_LABELS[row.priority],
    // The user's own due date wins over the posting's parsed deadline —
    // the home page rows' pickDeadline precedence.
    dueDate: isoOrNull(row.dueDate) ?? isoOrNull(row.deadline),
    url: row.url,
    openFollowups: openByTask.get(row.id) ?? 0,
  };
}

export interface FollowupRow {
  id: string;
  taskId: string;
  kind: FollowupKind;
  title: string;
  state: FollowupState;
  dueDate: Date | null;
  company: string | null;
  jobSpec: JobSpec | null;
}

export function followupCard(row: FollowupRow): FollowupCard {
  return {
    id: row.id,
    taskId: row.taskId,
    kind: row.kind,
    kindLabel: FOLLOWUP_KIND_LABELS[row.kind],
    title: row.title,
    state: row.state,
    stateLabel: FOLLOWUP_STATE_LABELS[row.state],
    dueDate: isoOrNull(row.dueDate),
    // Same fallback the home page's "In play" rows render.
    company: row.company || row.jobSpec?.company || null,
  };
}

/** The task object of a task detail (shared by /mobile and /cli). */
export function taskDetailView(
  task: {
    id: string;
    state: TaskState;
    priority: TaskPriority;
    dueDate: Date | null;
    notes: string | null;
    jobSpec: JobSpec | null;
    createdAt: Date | null;
    updatedAt: Date | null;
  },
  job: {
    company: string | null;
    title: string | null;
    url: string | null;
    deadline: Date | null;
  },
) {
  const identity = taskIdentity({
    company: job.company,
    title: job.title,
    jobSpec: task.jobSpec,
    url: job.url,
  });
  return {
    id: task.id,
    state: task.state,
    priority: task.priority,
    priorityLabel: TASK_PRIORITY_LABELS[task.priority],
    dueDate: isoOrNull(task.dueDate) ?? isoOrNull(job.deadline),
    notes: task.notes,
    url: job.url,
    company: identity.company,
    title: identity.title,
    createdAt: isoOrNull(task.createdAt),
    updatedAt: isoOrNull(task.updatedAt),
  };
}

/**
 * A resolved answer as display text — the minimal mirror of the dashboard
 * questions panel: document paths become filenames, select values their
 * option labels, arrays join, and anything non-string degrades to compact
 * JSON rather than "[object Object]".
 */
function renderAnswerValue(
  question: Question,
  answer: ResolvedAnswer,
  filenameByPath: Map<string, string>,
): string | null {
  if (answer.value === null) {
    return null;
  }
  const raw = Array.isArray(answer.value) ? answer.value : [answer.value];
  const parts = raw.map((value) => {
    if (typeof value !== 'string') {
      return JSON.stringify(value);
    }
    if (answer.source === 'document') {
      return filenameByPath.get(value) ?? value;
    }
    if (question.type === 'select' || question.type === 'multiselect') {
      const option = (question.options ?? []).find(
        (o) => String(o.value) === value,
      );
      return option?.label ?? value;
    }
    return value;
  });
  return parts.join(', ');
}

export interface QuestionSummary {
  id: string;
  label: string;
  type: Question['type'];
  required: boolean;
  /** 'saved' appears only when a SavedContext is supplied (the /cli routes). */
  status: 'resolved' | 'missing' | 'unresolved' | 'saved';
  value: string | null;
  source: string | null;
  /** Source-declared answer cap, passed through when the spec carries one. */
  limit?: { kind: 'characters' | 'words'; max: number };
  /** 'saved' status: the banked answer as display text (dashboard parity). */
  savedValues?: string[];
  /** 'saved' status: what the resolver will actually fill on the next run. */
  savedInput?: string[];
  /** 'saved' file questions: the picked document's id. */
  savedDocId?: string;
}

/** A stored document, keyed by storagePath for saved file-answer views. */
export interface DocumentInfo {
  id: string;
  kind: string;
  filename: string;
}

/**
 * The answers-bank context that lets buildQuestions surface the dashboard's
 * 'saved' status: an answer the stored resolution still lists as missing but
 * that already exists in the answers bank (typically saved moments ago —
 * async reprocessing has not refreshed the resolution yet).
 */
export interface SavedContext {
  bank: BankEntry[];
  /** The job's company (raw; selectBankValue normalizes defensively). */
  company: string | undefined;
  docByPath: Map<string, DocumentInfo>;
}

/**
 * The dashboard's buildSavedView, mirrored server-side: display and prefill
 * use the SAME matching the resolver will use on the next run
 * (matchStoredOption), so what this shows is exactly what will be filled in.
 * Returns null when the bank value cannot apply here (stale doc pick, array
 * into a text field) — the question then stays truly missing.
 */
function buildSavedView(
  base: Omit<QuestionSummary, 'status' | 'value' | 'source'>,
  question: Question,
  saved: BankValue,
  docByPath: Map<string, DocumentInfo>,
): QuestionSummary | null {
  const savedBase = { ...base, value: null, source: null };
  if (question.type === 'file') {
    // Doc picks store the chosen document's storagePath (a string).
    if (typeof saved !== 'string') {
      return null;
    }
    const doc = docByPath.get(saved);
    if (!doc) {
      return null;
    }
    return {
      ...savedBase,
      status: 'saved',
      savedValues: [`${doc.filename} (${doc.kind})`],
      savedDocId: doc.id,
    };
  }

  if (question.type === 'select' || question.type === 'multiselect') {
    const items = Array.isArray(saved) ? saved : [saved];
    if (items.length === 0) {
      return null;
    }
    const display: string[] = [];
    const input: string[] = [];
    for (const item of items) {
      if (typeof item === 'object' && !isBankOptionValue(item)) {
        return null;
      }
      const option = matchStoredOption(item, question.options ?? []);
      // Prefill only options that exist on THIS form; the display still
      // shows the saved label even when the option ids differ (old-shape
      // cross-tenant rows).
      if (option !== undefined) {
        input.push(String(option.value));
      }
      display.push(
        option?.label ?? (isBankOptionValue(item) ? item.label : String(item)),
      );
    }
    return {
      ...savedBase,
      status: 'saved',
      savedValues: display,
      savedInput: input,
    };
  }

  // text / textarea — mirrors the resolver: arrays never fill a text field;
  // a {value,label} select answer contributes its human label.
  if (Array.isArray(saved)) {
    return null;
  }
  const text = isBankOptionValue(saved) ? saved.label : String(saved);
  return {
    ...savedBase,
    status: 'saved',
    savedValues: [text],
    savedInput: [text],
  };
}

export function buildQuestions(
  spec: JobSpec | null,
  resolution: ResolutionResult | null,
  filenameByPath: Map<string, string>,
  savedContext?: SavedContext,
): QuestionSummary[] {
  if (!spec) {
    return [];
  }
  const resolvedById = new Map(
    (resolution?.resolved ?? []).map((answer) => [answer.questionId, answer]),
  );
  const missingIds = new Set((resolution?.missing ?? []).map((q) => q.id));
  return spec.questions.map((question) => {
    const base = {
      id: question.id,
      label: question.label,
      type: question.type,
      required: question.required,
      ...(question.limit ? { limit: question.limit } : {}),
    };
    const answer = resolvedById.get(question.id);
    if (answer) {
      return {
        ...base,
        status: 'resolved' as const,
        value: renderAnswerValue(question, answer, filenameByPath),
        source: answer.source,
      };
    }
    const missing = resolution !== null && missingIds.has(question.id);
    if (missing && savedContext) {
      // The stored resolution says 'missing', but the answers bank may
      // already hold a matching answer — surface it as 'saved' so a save
      // visibly sticks before the next run applies it (dashboard parity).
      const banked = selectBankValue(
        question,
        savedContext.bank,
        savedContext.company,
      );
      if (banked !== undefined) {
        const savedView = buildSavedView(
          base,
          question,
          banked,
          savedContext.docByPath,
        );
        if (savedView !== null) {
          return savedView;
        }
      }
    }
    return {
      ...base,
      status: missing ? ('missing' as const) : ('unresolved' as const),
      value: null,
      source: null,
    };
  });
}

/**
 * One short human line per timeline event: the type prettified plus the few
 * data fields worth a glance (question/resolution counts, a note).
 */
export function eventSummary(type: string, data: unknown): string {
  const words = type.toLowerCase().replace(/_/g, ' ');
  const label = words.charAt(0).toUpperCase() + words.slice(1);
  const record =
    data && typeof data === 'object' && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : undefined;
  const extras: string[] = [];
  if (typeof record?.questionCount === 'number') {
    extras.push(
      `${record.questionCount} question${record.questionCount === 1 ? '' : 's'}`,
    );
  }
  if (
    typeof record?.resolved === 'number' &&
    typeof record?.missing === 'number'
  ) {
    extras.push(`${record.resolved} resolved, ${record.missing} missing`);
  }
  if (typeof record?.note === 'string' && record.note !== '') {
    extras.push(record.note);
  }
  return extras.length > 0 ? `${label} — ${extras.join(' · ')}` : label;
}
