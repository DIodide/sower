'use client';

import { useRouter } from 'next/navigation';
import { useActionState } from 'react';
import type { ActionResult } from './actions';
import {
  approveTask,
  discardTask,
  markApplied,
  requeueTask,
  restoreTask,
  startSessionCapture,
  verifyDiscoveredForm,
} from './actions';

type Mode =
  | 'requeue'
  | 'approve'
  | 'start'
  | 'verify'
  | 'discard'
  | 'restore'
  | 'mark-applied';

const LABELS: Record<Mode, { idle: string; className: string; title: string }> =
  {
    approve: {
      idle: 'Approve & dry-run submit',
      className: 'btn btn--success',
      title:
        'Constructs and records the submission payload — nothing is sent to the platform',
    },
    requeue: {
      idle: 'Requeue task',
      className: 'btn btn--primary',
      title: 'Puts the task back on the queue for another processing attempt',
    },
    start: {
      idle: 'Start session capture',
      className: 'btn btn--primary',
      title:
        'Asks the local agent to open a browser on your machine so you can sign in to Workday',
    },
    verify: {
      idle: 'Verify form — I checked it against the real page',
      className: 'btn btn--success',
      title:
        'Confirms that you, a human, checked the machine-extracted questions against the real application form — marks the form verified and updates the Discord ingest reply',
    },
    discard: {
      idle: 'Discard task',
      className: 'btn btn--danger',
      title:
        'Removes this task from the queue — nothing will run for it anymore (the record and history are kept)',
    },
    restore: {
      idle: 'Restore to queue',
      className: 'btn',
      title:
        'Puts this task back in the queue (as needs-input) — the auto-discard rule never re-discards a restored task',
    },
    'mark-applied': {
      idle: 'Mark applied',
      className: 'btn btn--success',
      title:
        'Records that you completed this application yourself, outside sower — the task moves to Sent and nothing will run for it anymore',
    },
  };

/** Modes carrying an optional free-text note on the same row as the button. */
const NOTE_PLACEHOLDERS: Partial<Record<Mode, string>> = {
  discard: 'why? (optional — saved with the discard)',
  'mark-applied': 'where/how? (optional)',
};

export function TaskActions({ taskId, mode }: { taskId: string; mode: Mode }) {
  const router = useRouter();
  const [result, formAction, pending] = useActionState<
    ActionResult | null,
    FormData
  >(async (_prev, formData) => {
    const run = (): Promise<ActionResult> => {
      if (mode === 'approve') return approveTask(taskId);
      if (mode === 'start') return startSessionCapture(taskId);
      if (mode === 'verify') return verifyDiscoveredForm(taskId);
      if (mode === 'restore') return restoreTask(taskId);
      if (mode === 'discard' || mode === 'mark-applied') {
        // The optional note typed next to the button — empty is fine.
        const note = formData.get('note');
        const value = typeof note === 'string' ? note : undefined;
        return mode === 'discard'
          ? discardTask(taskId, value)
          : markApplied(taskId, value);
      }
      return requeueTask(taskId);
    };
    const outcome = await run();
    // The action's revalidatePath alone can leave THIS page's banner/badge
    // stale (the restore-from-archive bug); an explicit client refresh makes
    // every state change land without a manual reload.
    if (outcome.ok) router.refresh();
    return outcome;
  }, null);

  const label = LABELS[mode];
  const notePlaceholder = NOTE_PLACEHOLDERS[mode];
  return (
    <form action={formAction}>
      <div className="row">
        <button
          type="submit"
          disabled={pending}
          className={label.className}
          title={label.title}
        >
          {pending ? 'Working…' : label.idle}
        </button>
        {notePlaceholder ? (
          <input
            type="text"
            name="note"
            className="field discard-note"
            placeholder={notePlaceholder}
            aria-label={
              mode === 'discard'
                ? 'Discard note (optional)'
                : 'Where/how you applied (optional)'
            }
            title={
              mode === 'discard'
                ? 'Saved with the discard so future-you knows why'
                : 'Saved with the task so future-you knows where/how you applied'
            }
            maxLength={2000}
            disabled={pending}
          />
        ) : null}
      </div>
      {result ? (
        <p
          role="status"
          className={result.ok ? 'status-ok' : 'status-err'}
          style={{ margin: '0.625rem 0 0', wordBreak: 'break-word' }}
        >
          {result.message}
        </p>
      ) : null}
    </form>
  );
}
