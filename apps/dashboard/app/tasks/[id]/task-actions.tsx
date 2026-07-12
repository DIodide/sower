'use client';

import { useActionState } from 'react';
import type { ActionResult } from './actions';
import { approveTask, requeueTask } from './actions';

export function TaskActions({
  taskId,
  mode,
}: {
  taskId: string;
  mode: 'requeue' | 'approve';
}) {
  const [result, formAction, pending] = useActionState<
    ActionResult | null,
    FormData
  >(
    async () =>
      mode === 'approve' ? approveTask(taskId) : requeueTask(taskId),
    null,
  );

  return (
    <form action={formAction}>
      <div className="row">
        {mode === 'approve' ? (
          <button
            type="submit"
            disabled={pending}
            className="btn btn--success"
            title="Constructs and records the submission payload — nothing is sent to the platform"
          >
            {pending ? 'Working…' : 'Approve & dry-run submit'}
          </button>
        ) : (
          <button
            type="submit"
            disabled={pending}
            className="btn btn--primary"
            title="Puts the task back on the queue for another processing attempt"
          >
            {pending ? 'Working…' : 'Requeue task'}
          </button>
        )}
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
