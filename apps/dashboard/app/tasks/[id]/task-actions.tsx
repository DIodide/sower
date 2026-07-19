'use client';

import { useActionState } from 'react';
import type { ActionResult } from './actions';
import {
  approveTask,
  discardTask,
  requeueTask,
  startSessionCapture,
  verifyDiscoveredForm,
} from './actions';

const LABELS: Record<
  'requeue' | 'approve' | 'start' | 'verify' | 'discard',
  { idle: string; className: string; title: string }
> = {
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
};

export function TaskActions({
  taskId,
  mode,
}: {
  taskId: string;
  mode: 'requeue' | 'approve' | 'start' | 'verify' | 'discard';
}) {
  const [result, formAction, pending] = useActionState<
    ActionResult | null,
    FormData
  >(async (_prev, formData) => {
    if (mode === 'approve') return approveTask(taskId);
    if (mode === 'start') return startSessionCapture(taskId);
    if (mode === 'verify') return verifyDiscoveredForm(taskId);
    if (mode === 'discard') {
      // The optional "why" typed next to the button — empty is fine.
      const note = formData.get('note');
      return discardTask(taskId, typeof note === 'string' ? note : undefined);
    }
    return requeueTask(taskId);
  }, null);

  const label = LABELS[mode];
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
        {mode === 'discard' ? (
          <input
            type="text"
            name="note"
            className="field discard-note"
            placeholder="why? (optional — saved with the discard)"
            aria-label="Discard note (optional)"
            title="Saved with the discard so future-you knows why"
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
