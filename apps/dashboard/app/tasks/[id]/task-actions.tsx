'use client';

import { useActionState } from 'react';
import { MUTED } from '../../../lib/ui';
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
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.75rem',
          flexWrap: 'wrap',
        }}
      >
        {mode === 'approve' ? (
          <>
            <button
              type="submit"
              disabled={pending}
              style={{
                backgroundColor: '#143322',
                color: '#4ade80',
                border: '1px solid #1f4d33',
                borderRadius: '0.375rem',
                padding: '0.375rem 0.875rem',
                fontSize: '0.8rem',
                fontWeight: 600,
                cursor: 'pointer',
                opacity: pending ? 0.6 : 1,
              }}
            >
              Approve &amp; dry-run submit
            </button>
            <span style={{ fontSize: '0.75rem', color: MUTED }}>
              dry run only — the payload is constructed and recorded; nothing is
              sent to the platform.
            </span>
          </>
        ) : (
          <button
            type="submit"
            disabled={pending}
            style={{
              backgroundColor: '#16283f',
              color: '#93c5fd',
              border: '1px solid #2a3145',
              borderRadius: '0.375rem',
              padding: '0.375rem 0.875rem',
              fontSize: '0.8rem',
              fontWeight: 600,
              cursor: 'pointer',
              opacity: pending ? 0.6 : 1,
            }}
          >
            Requeue
          </button>
        )}
        {pending ? (
          <span style={{ fontSize: '0.8rem', color: MUTED }}>working…</span>
        ) : null}
      </div>
      {result ? (
        <p
          role="status"
          style={{
            marginTop: '0.75rem',
            marginBottom: 0,
            fontSize: '0.8rem',
            color: result.ok ? '#4ade80' : '#f87171',
            wordBreak: 'break-word',
          }}
        >
          {result.message}
        </p>
      ) : null}
    </form>
  );
}
