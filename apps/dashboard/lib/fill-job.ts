// Pure view logic for the browser-fill panel (fill_jobs rows): status chip
// metadata and the report jsonb narrowing. Kept in lib/ so it is unit-testable
// without React or a database.
import type { Tone } from './format';

/** fill_jobs.status values (packages/db migration 0024_fill_jobs). */
export type FillJobStatus =
  | 'requested'
  | 'claimed'
  | 'running'
  | 'ready'
  | 'failed';

export interface FillStatusMeta {
  /** Chip text ("waiting for the runner…", not the raw status). */
  label: string;
  tone: Tone;
  /** True while the runner still owes an update — the panel polls. */
  active: boolean;
}

const FILL_STATUS_META: Record<FillJobStatus, FillStatusMeta> = {
  requested: {
    label: 'waiting for the runner…',
    tone: 'progress',
    active: true,
  },
  claimed: { label: 'filling…', tone: 'progress', active: true },
  running: { label: 'filling…', tone: 'progress', active: true },
  ready: { label: 'browser ready', tone: 'success', active: false },
  failed: { label: 'failed', tone: 'danger', active: false },
};

/** FILL_STATUS_META lookup that tolerates unknown/legacy status strings. */
export function fillStatusMeta(status: string): FillStatusMeta {
  const meta = (FILL_STATUS_META as Record<string, FillStatusMeta>)[status];
  if (meta) return meta;
  return {
    label: status.toLowerCase().replace(/_/g, ' '),
    tone: 'neutral',
    active: false,
  };
}

/** Per-field outcomes the runner reports (file questions arrive 'skipped'). */
export type FillOutcome = 'filled' | 'skipped' | 'failed';

export const FILL_OUTCOME_TONE: Record<FillOutcome, Tone> = {
  filled: 'success',
  skipped: 'neutral',
  failed: 'danger',
};

export interface FillReportEntry {
  questionId: string;
  label: string;
  outcome: FillOutcome;
  detail?: string;
}

function isFillOutcome(value: unknown): value is FillOutcome {
  return value === 'filled' || value === 'skipped' || value === 'failed';
}

/**
 * Narrow the fill_jobs.report jsonb into typed entries. Malformed entries
 * are dropped (never crash the panel over one bad row); a non-array report
 * yields an empty list, which the panel renders as "no report".
 */
export function parseFillReport(value: unknown): FillReportEntry[] {
  if (!Array.isArray(value)) return [];
  const entries: FillReportEntry[] = [];
  for (const item of value) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      continue;
    }
    const record = item as Record<string, unknown>;
    if (typeof record.questionId !== 'string') continue;
    if (typeof record.label !== 'string') continue;
    if (!isFillOutcome(record.outcome)) continue;
    entries.push({
      questionId: record.questionId,
      label: record.label,
      outcome: record.outcome,
      ...(typeof record.detail === 'string' && record.detail !== ''
        ? { detail: record.detail }
        : {}),
    });
  }
  return entries;
}

/**
 * Platforms the runner has a form executor for. Mirrors the api's
 * FILLABLE_PLATFORMS (fill-jobs.ts) — the page hides the button where the
 * api would answer 409.
 */
export const FILLABLE_PLATFORMS: ReadonlySet<string> = new Set([
  'greenhouse',
  'ashby',
]);
