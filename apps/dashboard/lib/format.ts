import type { TaskState } from '@sower/core';

/** Absolute UTC timestamp, minute precision: `2026-07-11 14:03 UTC`. */
export function formatDate(value: Date | string | null | undefined): string {
  if (!value) return '—';
  const d = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.toISOString().replace('T', ' ').slice(0, 16)} UTC`;
}

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
 * Buckets group the 12 raw machine states into the four things a person
 * actually scans for: work waiting on them, work the system is doing,
 * finished work, and problems.
 */
export type Bucket = 'action' | 'active' | 'done' | 'stalled';

export interface StateMeta {
  /** Human-readable label ("Needs input", not NEEDS_INPUT). */
  label: string;
  tone: Tone;
  bucket: Bucket;
}

export const STATE_META: Record<TaskState, StateMeta> = {
  INGESTED: { label: 'Ingested', tone: 'progress', bucket: 'active' },
  PARSED: { label: 'Parsed', tone: 'progress', bucket: 'active' },
  QUEUED: { label: 'Queued', tone: 'progress', bucket: 'active' },
  PREPARING: { label: 'Processing', tone: 'progress', bucket: 'active' },
  NEEDS_INPUT: { label: 'Needs input', tone: 'attention', bucket: 'action' },
  REVIEW: { label: 'Ready to review', tone: 'attention', bucket: 'action' },
  AWAITING_OTP: { label: 'Awaiting OTP', tone: 'attention', bucket: 'action' },
  FILLING: { label: 'Filling', tone: 'progress', bucket: 'active' },
  SUBMITTED: { label: 'Submitted', tone: 'success', bucket: 'done' },
  CONFIRMED: { label: 'Confirmed', tone: 'success', bucket: 'done' },
  FAILED: { label: 'Failed', tone: 'danger', bucket: 'stalled' },
  DUPLICATE: { label: 'Duplicate', tone: 'neutral', bucket: 'stalled' },
  // Deliberately removed from the queue by a human; hidden from the default
  // task list (not listed in any BUCKETS entry — reachable via ?state=).
  DISCARDED: { label: 'Discarded', tone: 'neutral', bucket: 'stalled' },
};

const FALLBACK_META: StateMeta = {
  label: 'Unknown',
  tone: 'neutral',
  bucket: 'stalled',
};

/** STATE_META lookup that tolerates unknown/legacy state strings. */
export function stateMeta(state: string): StateMeta {
  const meta = (STATE_META as Record<string, StateMeta>)[state];
  if (meta) return meta;
  return { ...FALLBACK_META, label: state.toLowerCase().replace(/_/g, ' ') };
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
    label: 'Submitted',
    tone: 'success',
    states: ['SUBMITTED', 'CONFIRMED'],
  },
  stalled: {
    label: 'Problems',
    tone: 'danger',
    states: ['FAILED', 'DUPLICATE'],
  },
};

export function isBucket(value: string): value is Bucket {
  return value in BUCKETS;
}

/** Truncates to `max` characters, appending an ellipsis when cut. */
export function truncate(value: string, max = 120): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}
