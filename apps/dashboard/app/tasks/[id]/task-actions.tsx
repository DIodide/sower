'use client';

import { useRouter } from 'next/navigation';
import { useActionState, useEffect } from 'react';
import { SECTIONS } from '../../../lib/format';
import type { ActionResult } from './actions';
import {
  approveTask,
  discardTask,
  investigateTask,
  markApplied,
  reingestTask,
  requestBrowserFill,
  requeueTask,
  restoreTask,
  startSessionCapture,
  unmarkApplied,
  verifyDiscoveredForm,
} from './actions';

type Mode =
  | 'requeue'
  | 'approve'
  | 'start'
  | 'verify'
  | 'investigate'
  | 'discard'
  | 'restore'
  | 'mark-applied'
  | 'unmark-applied'
  | 'reingest'
  | 'fill';

const LABELS: Record<Mode, { idle: string; className: string; title: string }> =
  {
    approve: {
      idle: 'Approve & dry-run submit',
      className: 'btn btn--success',
      title: `Constructs and records the submission payload — nothing is sent to the platform, and the task stays in "${SECTIONS.waiting}"`,
    },
    requeue: {
      idle: 'Requeue task',
      className: 'btn btn--primary',
      title: `Runs another processing attempt — the task moves to "${SECTIONS.processing}"`,
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
    investigate: {
      idle: 'Run the browser agent',
      className: 'btn btn--primary',
      title:
        "Starts the form-discovery browser agent on this job's page — discovered questions land on this task for you to verify",
    },
    discard: {
      idle: 'Discard task',
      className: 'btn btn--danger',
      title: `Moves this task to the ${SECTIONS.archive} — the record and history are kept, and Restore brings it back`,
    },
    restore: {
      idle: 'Restore to queue',
      className: 'btn',
      title: `Puts this task back in "${SECTIONS.waiting}" — the auto-discard rule never re-discards a restored task`,
    },
    'mark-applied': {
      idle: 'Mark applied',
      className: 'btn btn--success',
      title: `Records that you completed this application yourself, outside sower — the task moves to ${SECTIONS.sent}`,
    },
    'unmark-applied': {
      idle: 'Un-mark applied',
      className: 'btn',
      title: `"Mark applied" was a mistake — moves this task back in "${SECTIONS.waiting}"; only out-of-band marks can be undone, never a real sower submission`,
    },
    reingest: {
      idle: 'Re-ingest',
      className: 'btn',
      title:
        'Reset this task and re-run it through ingestion from scratch — same task, fresh parse',
    },
    fill: {
      idle: 'Fill in browser',
      className: 'btn btn--primary',
      title:
        'Asks the runner on your machine to open the real greenhouse form in a browser and fill in your answered questions — nothing is ever submitted; you review and finish in the live view',
    },
  };

/** Modes carrying an optional free-text note. The input is ALWAYS visible
 *  next to the button and the action fires on the FIRST press — the note is
 *  optional and can be typed before (or never). A hide-until-clicked reveal
 *  proved backwards: it hid the field until after the decision was made. */
const NOTE_MODES: Partial<Record<Mode, { placeholder: string }>> = {
  discard: {
    placeholder: 'why? (optional — saved with the discard)',
  },
  'mark-applied': {
    placeholder: 'where/how? (optional)',
  },
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
      if (mode === 'investigate') return investigateTask(taskId);
      if (mode === 'restore') return restoreTask(taskId);
      if (mode === 'unmark-applied') return unmarkApplied(taskId);
      if (mode === 'reingest') return reingestTask(taskId);
      if (mode === 'fill') return requestBrowserFill(taskId);
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
    return run();
  }, null);

  // The refresh must fire AFTER the action's transition settles: calling
  // router.refresh() inside the useActionState reducer runs while the form
  // transition is still pending, and the refetch gets absorbed — the page
  // kept its stale banner/badge until a manual reload (live: Mark applied).
  // The action's revalidatePath alone is not enough either (the
  // restore-from-archive bug); this effect makes every state change land.
  useEffect(() => {
    if (result?.ok) router.refresh();
  }, [result, router]);

  const label = LABELS[mode];
  const noteMode = NOTE_MODES[mode];
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
        {noteMode ? (
          <input
            type="text"
            name="note"
            className="field discard-note"
            placeholder={noteMode.placeholder}
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
