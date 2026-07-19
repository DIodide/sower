// Shared presentation helpers for resume-editor runs. No 'use client'
// directive on purpose: the server page needs commitUrl/shortSha and the
// RunSnapshot shape, while the client tabs/poller need everything — a client
// module's exports would not be callable from the server component.

import type { ResumeRunKind, TranscriptStep } from '@sower/db';
import type { Tone } from '../../../lib/format';
import type { ResumeRunStatus as PolledRun } from './actions';

/**
 * One resume-editor run, serialized for the server → client boundary (ISO
 * strings, transcript validated into TranscriptStep[]). Produced from the DB
 * row by the page and from the poll payload by snapshotFromPoll, so the live
 * view and the History tab render the same shape.
 */
export interface RunSnapshot {
  id: string;
  kind: ResumeRunKind;
  status: 'running' | 'succeeded' | 'failed';
  /** agent runs: the user's request. Null for sync runs and poll payloads
   *  (GET /resumes/runs/:id omits it — the live view doesn't need it). */
  prompt: string | null;
  transcript: TranscriptStep[];
  commitSha: string | null;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

/**
 * Coerce the poll payload's untyped transcript into renderable steps: keep
 * only objects with the numeric seq/ts + string kind the step renderer keys
 * on, sorted by seq (the job appends, but never trust jsonb ordering).
 */
export function asTranscript(value: unknown): TranscriptStep[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((step): step is TranscriptStep => {
      if (step === null || typeof step !== 'object') return false;
      const s = step as Record<string, unknown>;
      return (
        typeof s.seq === 'number' &&
        typeof s.kind === 'string' &&
        typeof s.ts === 'number'
      );
    })
    .sort((a, b) => a.seq - b.seq);
}

/** The getRunStatus payload → the shared snapshot shape. */
export function snapshotFromPoll(run: PolledRun): RunSnapshot {
  return {
    id: run.id,
    kind: run.kind,
    status: run.status,
    prompt: null,
    transcript: asTranscript(run.transcript),
    commitSha: run.commitSha ?? null,
    error: run.error ?? null,
    startedAt: run.startedAt ?? null,
    finishedAt: run.finishedAt ?? null,
  };
}

export const KIND_META: Record<
  ResumeRunKind,
  {
    /** History badge text. */
    label: string;
    tone: Tone | 'accent';
    /** History excerpt when there is no prompt to show. */
    fallbackExcerpt: string;
    /** Live status line while the run is in flight. */
    runningLabel: string;
  }
> = {
  sync: {
    label: 'sync',
    tone: 'neutral',
    fallbackExcerpt: 'repo sync',
    runningLabel: 'Syncing from the repo',
  },
  agent: {
    label: 'agent',
    tone: 'accent',
    fallbackExcerpt: 'change request',
    runningLabel: 'Claude is working',
  },
  write: {
    label: 'edit',
    tone: 'neutral',
    fallbackExcerpt: 'manual edit',
    runningLabel: 'Committing and recompiling',
  },
};

export const STATUS_META: Record<
  RunSnapshot['status'],
  { label: string; tone: Tone }
> = {
  running: { label: 'Running', tone: 'progress' },
  succeeded: { label: 'Succeeded', tone: 'success' },
  failed: { label: 'Failed', tone: 'danger' },
};

/** The portfolio repo the resume editor commits to. */
const COMMIT_URL_BASE = 'https://github.com/DIodide/portfolio/commit/';

export function commitUrl(sha: string): string {
  return `${COMMIT_URL_BASE}${encodeURIComponent(sha)}`;
}

export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}
