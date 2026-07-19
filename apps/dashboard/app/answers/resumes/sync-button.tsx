'use client';

// "Sync from repo" trigger: starts the repo-wide sync run, polls it via the
// shared useRunPoll loop (2s / 15min budget), and router.refresh()es on
// success so the resumes rows, PDFs, and history all reappear server-fresh.
// Used both by the page's empty state and each resume's header row.

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { syncResumes } from './actions';
import { useRunPoll } from './run-view';

export function SyncButton({
  label = 'Sync',
  primary = false,
}: {
  label?: string;
  primary?: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [runId, setRunId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { run, timedOut } = useRunPoll(runId, null, (settled) => {
    if (settled.status === 'succeeded') router.refresh();
  });

  const syncing =
    pending ||
    (runId !== null && !timedOut && (run === null || run.status === 'running'));

  const start = () => {
    setError(null);
    startTransition(async () => {
      const result = await syncResumes();
      if (result.ok && result.runId) {
        setRunId(result.runId);
      } else {
        setError(result.message);
        setRunId(null);
      }
    });
  };

  return (
    <span
      className="row"
      style={{ gap: '0.5rem', alignItems: 'baseline', flexWrap: 'wrap' }}
    >
      <button
        type="button"
        className={primary ? 'btn btn--primary' : 'btn'}
        disabled={syncing}
        onClick={start}
        title="Clone the portfolio repo, recompile every resume, refresh the stored PDFs"
      >
        {syncing ? 'Syncing…' : label}
      </button>
      {error ? (
        <span className="status-err">{error}</span>
      ) : run?.status === 'failed' ? (
        <span className="status-err">{run.error ?? 'sync failed'}</span>
      ) : run?.status === 'succeeded' ? (
        <span className="status-ok">Synced — refreshing.</span>
      ) : timedOut ? (
        <span className="hint">Still running — check History later.</span>
      ) : runId && syncing ? (
        <span className="hint faint">Compiling resumes…</span>
      ) : null}
    </span>
  );
}
