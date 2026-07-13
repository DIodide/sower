'use client';

import { useActionState } from 'react';
import type { ActionResult } from './actions';
import { submitOtp } from './actions';

/**
 * Enter the one-time code emailed by an account-based platform (Workday) for
 * an AWAITING_OTP task. Mirrors the Discord modal — either delivers the code
 * to the same api endpoint, which resumes the task.
 */
export function OtpForm({ taskId }: { taskId: string }) {
  const [result, formAction, pending] = useActionState<
    ActionResult | null,
    FormData
  >(async (_prev, formData) => {
    const code = String(formData.get('code') ?? '');
    return submitOtp(taskId, code);
  }, null);

  return (
    <form action={formAction}>
      <div className="row">
        <input
          type="text"
          name="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          placeholder="e.g. 482913"
          aria-label="One-time code from the verification email"
          disabled={pending}
          className="field mono"
          style={{ maxWidth: '12rem' }}
        />
        <button type="submit" disabled={pending} className="btn btn--primary">
          {pending ? 'Submitting…' : 'Submit code'}
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
