'use client';

import { useActionState } from 'react';
import type { ActionResult } from './actions';
import { approveTask, requeueTask, startSessionCapture } from './actions';

const LABELS: Record<
  'requeue' | 'approve' | 'start',
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
};

export function TaskActions({
  taskId,
  mode,
}: {
  taskId: string;
  mode: 'requeue' | 'approve' | 'start';
}) {
  const [result, formAction, pending] = useActionState<
    ActionResult | null,
    FormData
  >(async () => {
    if (mode === 'approve') return approveTask(taskId);
    if (mode === 'start') return startSessionCapture(taskId);
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
