import type { TaskState } from '@sower/core';

/** The timezone the dashboard renders local times in. */
const DISPLAY_TZ = 'America/New_York';

const LOCAL_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: DISPLAY_TZ,
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  timeZoneName: 'short',
});

/**
 * Readable local timestamp (Eastern), e.g. `Jul 13, 3:47 PM EDT`. Uses a fixed
 * timezone via Intl so it renders identically on the server (Cloud Run = UTC)
 * and the client — no hydration mismatch, and always the user's zone.
 */
export function formatLocal(value: Date | string | null | undefined): string {
  if (!value) return '—';
  const d = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return '—';
  return LOCAL_FMT.format(d);
}

const RELATIVE_UNITS: { ms: number; label: string }[] = [
  { ms: 365 * 24 * 60 * 60 * 1000, label: 'y' },
  { ms: 30 * 24 * 60 * 60 * 1000, label: 'mo' },
  { ms: 7 * 24 * 60 * 60 * 1000, label: 'w' },
  { ms: 24 * 60 * 60 * 1000, label: 'd' },
  { ms: 60 * 60 * 1000, label: 'h' },
  { ms: 60 * 1000, label: 'm' },
];

// jobs.deadline is stored as UTC MIDNIGHT of the published calendar date, so
// deadline formatters must render in UTC — an Eastern render would show the
// evening BEFORE the actual deadline date.
const DEADLINE_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'UTC',
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});

const DEADLINE_CHIP_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'UTC',
  month: 'short',
  day: 'numeric',
});

/** Absolute deadline date, e.g. `Jul 30, 2026` (UTC — see note above). */
export function formatDeadline(
  value: Date | string | null | undefined,
): string {
  if (!value) return '—';
  const d = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return '—';
  return DEADLINE_FMT.format(d);
}

/**
 * Compact deadline chip label: `Jul 30` this year, `Jul 30, 2027` otherwise
 * (a bare month-day would silently mean the wrong year).
 */
export function deadlineChipLabel(
  value: Date | string | null | undefined,
): string | null {
  if (!value) return null;
  const d = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return null;
  return d.getUTCFullYear() === new Date().getUTCFullYear()
    ? DEADLINE_CHIP_FMT.format(d)
    : DEADLINE_FMT.format(d);
}

const DEADLINE_SOON_MS = 7 * 24 * 60 * 60 * 1000;

/** True when the deadline is within 7 days (or already past) — red tint. */
export function isDeadlineSoon(
  value: Date | string | null | undefined,
): boolean {
  if (!value) return false;
  const d = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return false;
  return d.getTime() - Date.now() <= DEADLINE_SOON_MS;
}

/** Compact relative time: `3m ago`, `2d ago`, `in 1h`, `just now`. */
export function relativeTime(value: Date | string | null | undefined): string {
  if (!value) return '—';
  const d = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return '—';
  const diff = Date.now() - d.getTime();
  const abs = Math.abs(diff);
  if (abs < 60 * 1000) return 'just now';
  for (const unit of RELATIVE_UNITS) {
    if (abs >= unit.ms) {
      const n = Math.floor(abs / unit.ms);
      return diff >= 0 ? `${n}${unit.label} ago` : `in ${n}${unit.label}`;
    }
  }
  return 'just now';
}

/** Semantic color families shared by badges, banners, and stat cards. */
export type Tone = 'attention' | 'progress' | 'success' | 'danger' | 'neutral';

/**
 * Buckets group the raw machine states into the four things a person
 * actually scans for: work waiting on them, work the system is doing,
 * finished work, and real failures. DUPLICATE and DISCARDED belong to no
 * bucket — they live only in the Archive.
 */
export type Bucket = 'action' | 'active' | 'done' | 'stalled';

export interface StateMeta {
  /** Human-readable label ("Needs input", not NEEDS_INPUT). */
  label: string;
  tone: Tone;
  /** 'archive' = parked history (DUPLICATE / DISCARDED), not a filter bucket. */
  bucket: Bucket | 'archive';
  /** Plain-words status phrase for list rows ("Needs your answers"). */
  need: string;
}

export const STATE_META: Record<TaskState, StateMeta> = {
  INGESTED: {
    label: 'Ingested',
    tone: 'progress',
    bucket: 'active',
    need: 'Processing…',
  },
  PARSED: {
    label: 'Parsed',
    tone: 'progress',
    bucket: 'active',
    need: 'Processing…',
  },
  QUEUED: {
    label: 'Queued',
    tone: 'progress',
    bucket: 'active',
    need: 'Processing…',
  },
  PREPARING: {
    label: 'Processing',
    tone: 'progress',
    bucket: 'active',
    need: 'Processing…',
  },
  NEEDS_INPUT: {
    label: 'Needs input',
    tone: 'attention',
    bucket: 'action',
    need: 'Needs your answers',
  },
  REVIEW: {
    label: 'Ready to review',
    tone: 'attention',
    bucket: 'action',
    need: 'Ready for your review',
  },
  AWAITING_OTP: {
    label: 'Awaiting OTP',
    tone: 'attention',
    bucket: 'action',
    need: 'Enter the email code',
  },
  FILLING: {
    label: 'Filling',
    tone: 'progress',
    bucket: 'active',
    need: 'Processing…',
  },
  SUBMITTED: {
    label: 'Submitted',
    tone: 'success',
    bucket: 'done',
    need: 'Sent',
  },
  CONFIRMED: {
    label: 'Confirmed',
    tone: 'success',
    bucket: 'done',
    need: 'Sent — confirmed',
  },
  FAILED: {
    label: 'Failed',
    tone: 'danger',
    bucket: 'stalled',
    need: 'Failed — retry?',
  },
  DUPLICATE: {
    label: 'Duplicate',
    tone: 'neutral',
    bucket: 'archive',
    need: 'Duplicate of another task',
  },
  // Deliberately removed from the queue by a human; lives in the Archive.
  DISCARDED: {
    label: 'Discarded',
    tone: 'neutral',
    bucket: 'archive',
    need: 'Discarded',
  },
};

const FALLBACK_META: StateMeta = {
  label: 'Unknown',
  tone: 'neutral',
  bucket: 'archive',
  need: 'Unknown state',
};

/** STATE_META lookup that tolerates unknown/legacy state strings. */
export function stateMeta(state: string): StateMeta {
  const meta = (STATE_META as Record<string, StateMeta>)[state];
  if (meta) return meta;
  const label = state.toLowerCase().replace(/_/g, ' ');
  return { ...FALLBACK_META, label, need: label };
}

export const BUCKETS: Record<
  Bucket,
  { label: string; tone: Tone; states: TaskState[] }
> = {
  action: {
    label: 'Needs you',
    tone: 'attention',
    states: ['NEEDS_INPUT', 'REVIEW', 'AWAITING_OTP'],
  },
  active: {
    label: 'In progress',
    tone: 'progress',
    states: ['INGESTED', 'PARSED', 'QUEUED', 'PREPARING', 'FILLING'],
  },
  done: {
    label: 'Sent',
    tone: 'success',
    states: ['SUBMITTED', 'CONFIRMED'],
  },
  stalled: {
    label: 'Failed',
    tone: 'danger',
    states: ['FAILED'],
  },
};

export function isBucket(value: string): value is Bucket {
  return value in BUCKETS;
}

/**
 * The workspace's section names — the ONE vocabulary every surface uses for
 * destinations: section headings, action messages ('back in "Waiting on
 * you"', 'moved to Sent'), and button titles. Never a raw state enum.
 */
export const SECTIONS = {
  waiting: 'Waiting on you',
  processing: 'New & processing',
  sent: 'Sent',
  archive: 'Archive',
} as const;

/**
 * States where a priority (and the user note) no longer mean anything —
 * the task has left the queue. Shared by the list rows and the task detail
 * header so the two can never disagree.
 */
export const PRIORITY_LOCKED = new Set<string>([
  'SUBMITTED',
  'CONFIRMED',
  'DISCARDED',
  'DUPLICATE',
]);

/** Scheme + www. stripped, capped — the label of last resort. */
export function shortenUrl(url: string, max = 60): string {
  const stripped = url.replace(/^https?:\/\//, '').replace(/^www\./, '');
  if (stripped.length <= max) return stripped;
  return `${stripped.slice(0, max - 1).trimEnd()}…`;
}

export interface RowLabelParts {
  company?: string | null;
  title?: string | null;
  /** The task's discovered spec, consulted after the jobs row. */
  jobSpec?: { company?: string | null; title?: string | null } | null;
  url?: string | null;
}

/**
 * Row label: `Company — Role` (jobs row first, then the discovered spec),
 * the lone known part, or the shortened job URL — NEVER the bare task id.
 */
export function rowLabel(parts: RowLabelParts): string {
  const company = parts.company || parts.jobSpec?.company || '';
  const title = parts.title || parts.jobSpec?.title || '';
  if (company && title) return `${company} — ${title}`;
  if (company || title) return company || title;
  return parts.url ? shortenUrl(parts.url) : 'untitled job';
}

/** Human sentences for the activity timeline's machine event types. */
const EVENT_LABELS: Record<string, string> = {
  PARSE_OK: 'Job details parsed',
  PARSE_DUPLICATE: 'Marked as a duplicate of an existing task',
  ENQUEUE: 'Queued for processing',
  PARK: 'Parked — waiting on you',
  PROCESS_START: 'Processing started',
  RESOLVED_ALL: 'All questions answered',
  RESOLVED_PARTIAL: 'Answered what it could — some questions remain',
  APPROVED: 'Approved',
  FILLED: 'Application form filled',
  NEED_OTP: 'Waiting for the email code',
  SUBMIT_OK: 'Submitted',
  CONFIRM: 'Submission confirmed',
  FAIL: 'Processing failed',
  RETRY: 'Requeued',
  DISCARD: 'Discarded',
  RESTORE: 'Restored to the queue',
  MARK_SUBMITTED: 'Marked applied (out of band)',
  UNMARK_SUBMITTED: 'Un-marked applied — back in the queue',
  REINGESTED: 'Re-ingested — replaced by a fresh task',
  REJECTED: 'Rejected',
  FORM_DISCOVERED: 'Application form discovered by the browser agent',
  FORM_NOT_FOUND: 'Browser agent found no application form',
  FORM_VERIFIED: 'Discovered form verified by a human',
  INVESTIGATION_DONE: 'Browser agent finished investigating',
  INVESTIGATION_FOUND: 'Browser agent found the job posting',
  HANDOFF: 'Apply flow reached a supported platform — real task created',
  LISTING_EXPANDED:
    'Listing page expanded — individual jobs added to the queue',
  DEADLINE_ALERT: 'Deadline alert sent',
};

/**
 * Event type → readable sentence ("PARSE_OK" → "Job details parsed").
 * Unknown types degrade to lowercased words, never the raw enum.
 */
export function eventLabel(type: string): string {
  return EVENT_LABELS[type] ?? type.toLowerCase().replace(/_/g, ' ');
}

/** Truncates to `max` characters, appending an ellipsis when cut. */
export function truncate(value: string, max = 120): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}
