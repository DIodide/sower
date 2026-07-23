'use client';

// The header's quiet "wrong application?" affordance: the inbox poll can
// attach an email follow-up to the wrong same-company task, so the detail
// page offers an inline move — a select of candidate applications plus one
// confirm, calling the reassign action (FollowupActions' pattern:
// useActionState + router.refresh once the write lands).

import { useRouter } from 'next/navigation';
import { useActionState, useState } from 'react';
import type { ActionResult } from '../../tasks/[id]/actions';
import { reassignFollowup } from '../actions';

export function ReassignControl({
  followupId,
  currentTaskId,
  candidates,
}: {
  followupId: string;
  currentTaskId: string;
  /** SUBMITTED/CONFIRMED tasks + the current one, most recent first. */
  candidates: { id: string; label: string }[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState(currentTaskId);
  const [result, formAction, pending] = useActionState<
    ActionResult | null,
    FormData
  >(async (_prev, formData) => {
    const taskId = formData.get('taskId');
    const known = candidates.find((c) => c.id === taskId);
    if (known === undefined) {
      return { ok: false, message: 'pick an application.' };
    }
    if (known.id === currentTaskId) {
      // Already there — closing quietly beats a noise write.
      setOpen(false);
      return null;
    }
    const outcome = await reassignFollowup(followupId, known.id);
    if (outcome.ok) {
      setOpen(false);
      router.refresh();
    }
    return outcome;
  }, null);

  if (candidates.length < 2) return null;

  if (!open) {
    return (
      <button
        type="button"
        className="reassign-hint"
        title="Move this follow-up to a different application"
        onClick={() => {
          setSelected(currentTaskId);
          setOpen(true);
        }}
      >
        wrong application?
      </button>
    );
  }

  return (
    <form
      action={formAction}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '0.375rem',
        flexWrap: 'wrap',
      }}
    >
      <select
        name="taskId"
        className="field"
        style={{ width: 'auto', maxWidth: '22rem', fontSize: '0.8125rem' }}
        aria-label="Move this follow-up to"
        value={selected}
        onChange={(event) => setSelected(event.target.value)}
        disabled={pending}
      >
        {candidates.map((candidate) => (
          <option key={candidate.id} value={candidate.id}>
            {candidate.id === currentTaskId
              ? `${candidate.label} (current)`
              : candidate.label}
          </option>
        ))}
      </select>
      <button
        type="submit"
        className="btn btn--sm"
        disabled={pending || selected === currentTaskId}
      >
        Move
      </button>
      <button
        type="button"
        className="btn btn--quiet btn--sm"
        disabled={pending}
        onClick={() => setOpen(false)}
      >
        Cancel
      </button>
      {result && !result.ok ? (
        <span
          role="status"
          className="status-err"
          style={{ fontSize: '0.75rem' }}
        >
          {result.message}
        </span>
      ) : null}
    </form>
  );
}
