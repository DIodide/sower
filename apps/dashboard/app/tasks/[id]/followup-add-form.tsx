'use client';

// Inline "Add follow-up" form on the task page's Post-application panel:
// kind + title, with optional link and due date, one compact line. Validation
// lives in the server action (zod); this only refuses the obviously empty
// submit so the user gets an instant message. Mirrors TaskActions' pattern
// (useActionState + router.refresh once the write lands).

import type { FollowupKind } from '@sower/core';
import { FOLLOWUP_KIND_LABELS } from '@sower/core';
import { useRouter } from 'next/navigation';
import { useActionState, useRef } from 'react';
import { createFollowup } from '../../followups/actions';
import type { ActionResult } from './actions';

export function FollowupAddForm({ taskId }: { taskId: string }) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement | null>(null);
  const [result, formAction, pending] = useActionState<
    ActionResult | null,
    FormData
  >(async (_prev, formData) => {
    const kind = formData.get('kind');
    const title = formData.get('title');
    if (typeof kind !== 'string' || kind === '') {
      return { ok: false, message: 'pick what kind of follow-up this is.' };
    }
    if (typeof title !== 'string' || title.trim() === '') {
      return { ok: false, message: 'give the follow-up a title.' };
    }
    const url = formData.get('url');
    const dueDate = formData.get('dueDate');
    const outcome = await createFollowup(taskId, {
      kind: kind as FollowupKind,
      title: title.trim(),
      ...(typeof url === 'string' && url.trim() !== ''
        ? { url: url.trim() }
        : {}),
      ...(typeof dueDate === 'string' && dueDate !== '' ? { dueDate } : {}),
    });
    if (outcome.ok) {
      formRef.current?.reset();
      router.refresh();
    }
    return outcome;
  }, null);

  return (
    <form ref={formRef} action={formAction}>
      <div className="fu-add">
        <select
          name="kind"
          className="field"
          defaultValue="assessment"
          aria-label="Follow-up kind"
          disabled={pending}
        >
          {(
            Object.entries(FOLLOWUP_KIND_LABELS) as [FollowupKind, string][]
          ).map(([kind, label]) => (
            <option key={kind} value={kind}>
              {label}
            </option>
          ))}
        </select>
        <input
          type="text"
          name="title"
          className="field fu-add-title"
          placeholder="what arrived? e.g. HackerRank OA — 90 min"
          aria-label="Follow-up title"
          maxLength={300}
          required
          disabled={pending}
        />
        <input
          type="url"
          name="url"
          className="field fu-add-url"
          placeholder="https:// link (optional)"
          aria-label="Link (optional, https only)"
          maxLength={2000}
          disabled={pending}
        />
        <input
          type="date"
          name="dueDate"
          className="field fu-add-due"
          aria-label="Due date (optional)"
          title="Due date (optional)"
          disabled={pending}
        />
        <button
          type="submit"
          className="btn btn--primary"
          disabled={pending}
          title="Track this update on the application"
        >
          {pending ? 'Adding…' : 'Add follow-up'}
        </button>
      </div>
      {result ? (
        <p
          role="status"
          className={result.ok ? 'status-ok' : 'status-err'}
          style={{ margin: '0.5rem 0 0', wordBreak: 'break-word' }}
        >
          {result.message}
        </p>
      ) : null}
    </form>
  );
}
