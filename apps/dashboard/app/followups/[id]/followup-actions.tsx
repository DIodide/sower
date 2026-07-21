'use client';

// The follow-up detail page's action bar: one button per event ALLOWED from
// the current state (the server page computes the list from the @sower/core
// transition table). One form, one status line — every button submits the
// same action with its event value, mirroring the task page's TaskActions
// pattern (useActionState + router.refresh once the write lands).

import type { FollowupEvent } from '@sower/core';
import { FOLLOWUP_EVENT_LABELS } from '@sower/core';
import { useRouter } from 'next/navigation';
import { useActionState } from 'react';
import type { ActionResult } from '../../tasks/[id]/actions';
import { transitionFollowup } from '../actions';

/** Visual weight + tooltip per event: the "you're done here" resolutions
 *  read strongest, the bookkeeping steps stay quiet. */
const EVENT_STYLES: Record<
  FollowupEvent,
  { className: string; title: string }
> = {
  TRIAGE: {
    className: 'btn',
    title: 'This needs something from you — mark it action-needed',
  },
  SCHEDULE: {
    className: 'btn btn--primary',
    title: 'A time is on the calendar — mark it scheduled',
  },
  COMPLETE_STEP: {
    className: 'btn btn--primary',
    title: 'You did your part — now waiting on their response',
  },
  RESOLVE: {
    className: 'btn btn--success',
    title: 'Nothing further will happen here — mark this follow-up done',
  },
  DISMISS: {
    className: 'btn btn--danger',
    title: 'Not worth tracking — dismiss it (Reopen brings it back)',
  },
  REOPEN: {
    className: 'btn',
    title: 'Bring this follow-up back — it needs your action again',
  },
};

export function FollowupActions({
  followupId,
  taskId,
  events,
}: {
  followupId: string;
  /** Parent task id, so the transition revalidates its panel too. */
  taskId: string;
  /** The events allowed from the CURRENT state, in display order. */
  events: FollowupEvent[];
}) {
  const router = useRouter();
  const [result, formAction, pending] = useActionState<
    ActionResult | null,
    FormData
  >(async (_prev, formData) => {
    const event = formData.get('event');
    const known = events.find((e) => e === event);
    if (known === undefined) return { ok: false, message: 'invalid action.' };
    const outcome = await transitionFollowup(followupId, known, taskId);
    // revalidatePath alone can leave THIS page's badges stale (the task
    // page's restore-from-archive bug); an explicit client refresh makes
    // every state change land without a manual reload.
    if (outcome.ok) router.refresh();
    return outcome;
  }, null);

  if (events.length === 0) return null;

  return (
    <form action={formAction}>
      <div className="row">
        {events.map((event) => (
          <button
            key={event}
            type="submit"
            name="event"
            value={event}
            disabled={pending}
            className={EVENT_STYLES[event].className}
            title={EVENT_STYLES[event].title}
          >
            {FOLLOWUP_EVENT_LABELS[event]}
          </button>
        ))}
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
