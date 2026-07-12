import type { TaskState } from '@sower/core';

/** Absolute UTC timestamp, minute precision: `2026-07-11 14:03 UTC`. */
export function formatDate(value: Date | string | null | undefined): string {
  if (!value) return '—';
  const d = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.toISOString().replace('T', ' ').slice(0, 16)} UTC`;
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

/** Badge colors for every task state (dark theme: pill bg + text fg). */
export const STATE_COLORS: Record<TaskState, { bg: string; fg: string }> = {
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

export const FALLBACK_STATE_COLOR = { bg: '#26262b', fg: '#9ca3af' };

/** STATE_COLORS lookup that tolerates unknown/legacy state strings. */
export function stateColor(state: string): { bg: string; fg: string } {
  return (
    (STATE_COLORS as Record<string, { bg: string; fg: string }>)[state] ??
    FALLBACK_STATE_COLOR
  );
}

/** Truncates to `max` characters, appending an ellipsis when cut. */
export function truncate(value: string, max = 120): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}
