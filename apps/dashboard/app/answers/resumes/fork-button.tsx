'use client';

// "Fork" trigger in a resume's header: an inline mini-form for the new tex
// stem (client validation mirroring the api's fork-name rule), then
// forkResume → the shared useRunPoll loop (kind 'fork') → router.refresh()
// on success so the new resume appears as its own section on the page. 409
// name collisions surface inline via the action's message.

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { forkResume } from './actions';
import { useRunPoll } from './run-view';

/** Mirrors the api's fork-name rule: the lowercase stem of the new .tex. */
const FORK_NAME_RE = /^[a-z0-9_-]{2,60}$/;

export function ForkButton({ resumeId }: { resumeId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [runId, setRunId] = useState<string | null>(null);
  const { run, timedOut } = useRunPoll(runId, null, (settled) => {
    if (settled.status === 'succeeded') {
      setOpen(false);
      setName('');
      router.refresh();
    }
  });

  const forking =
    pending ||
    (runId !== null && !timedOut && (run === null || run.status === 'running'));

  const submit = () => {
    const trimmed = name.trim();
    if (!FORK_NAME_RE.test(trimmed)) {
      setError(
        'Name must be 2-60 lowercase letters, digits, dashes, or underscores.',
      );
      return;
    }
    setError(null);
    startTransition(async () => {
      const result = await forkResume(resumeId, trimmed);
      if (result.ok && result.runId) {
        setRunId(result.runId);
      } else {
        // Includes the api's 409 detail when the name is already taken.
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
      {open || forking ? (
        <form
          className="row"
          style={{ gap: '0.375rem', alignItems: 'center', flexWrap: 'wrap' }}
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <input
            // biome-ignore lint/a11y/noAutofocus: the input appears because the user just clicked Fork — focus continues their action
            autoFocus
            type="text"
            className="field"
            style={{ width: 'auto', flex: '0 1 12rem', fontSize: '0.8125rem' }}
            placeholder="e.g. product-manager"
            aria-label="New fork name"
            title="Becomes developer/resumes/<name>.tex"
            value={name}
            maxLength={60}
            disabled={forking}
            onChange={(event) => {
              setName(event.target.value.toLowerCase());
              if (error) setError(null);
            }}
          />
          <button
            type="submit"
            className="btn btn--primary btn--sm"
            disabled={forking || name.trim() === ''}
          >
            {forking ? 'Forking…' : 'Create fork'}
          </button>
          {!forking ? (
            <button
              type="button"
              className="btn btn--quiet btn--sm"
              onClick={() => {
                setOpen(false);
                setName('');
                setError(null);
              }}
            >
              Cancel
            </button>
          ) : null}
          <span
            className="hint faint"
            style={{ flexBasis: '100%', minWidth: 0 }}
          >
            becomes{' '}
            <span className="mono">
              developer/resumes/{name.trim() || '<name>'}.tex
            </span>
          </span>
        </form>
      ) : (
        <button
          type="button"
          className="btn"
          onClick={() => setOpen(true)}
          title="Copy this resume's current source to a new .tex and register it here"
        >
          Fork
        </button>
      )}
      {error ? (
        <span className="status-err">{error}</span>
      ) : run?.status === 'failed' ? (
        <span className="status-err">{run.error ?? 'fork failed'}</span>
      ) : run?.status === 'succeeded' ? (
        <span className="status-ok">Forked — refreshing.</span>
      ) : timedOut ? (
        <span className="hint">Still running — check History later.</span>
      ) : runId && forking ? (
        <span className="hint faint">Copying and compiling…</span>
      ) : null}
    </span>
  );
}
