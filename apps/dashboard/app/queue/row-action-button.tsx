'use client';

import { useState, useTransition } from 'react';
import type { ActionResult } from '../tasks/[id]/actions';

/**
 * One per-row action button for the Queue page (Discard / Run browser agent).
 *
 * Deliberately type="button", never a submit: every row lives inside the
 * page-wide bulk-discard <form>, and HTML forbids nested forms — so the row
 * action (a bound server action) is invoked directly, and its result message
 * is shown inline the way the task page's TaskActions does.
 */
export function RowActionButton({
  action,
  label,
  className,
  title,
}: {
  action: () => Promise<ActionResult>;
  label: string;
  className: string;
  title?: string;
}) {
  const [result, setResult] = useState<ActionResult | null>(null);
  const [pending, startTransition] = useTransition();
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '0.5rem',
        flexWrap: 'wrap',
      }}
    >
      <button
        type="button"
        className={className}
        title={title}
        disabled={pending}
        onClick={() => {
          startTransition(async () => {
            setResult(await action());
          });
        }}
      >
        {pending ? 'Working…' : label}
      </button>
      {result ? (
        <span
          role="status"
          className={result.ok ? 'status-ok' : 'status-err'}
          style={{ fontSize: '0.8125rem', maxWidth: '18rem' }}
        >
          {result.message}
        </span>
      ) : null}
    </span>
  );
}
