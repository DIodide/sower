'use client';

import { useRouter } from 'next/navigation';
import { useActionState, useState } from 'react';
import { SECTIONS } from '../../../lib/format';
import type { ActionResult } from './actions';
import {
  approveTask,
  discardTask,
  investigateTask,
  markApplied,
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
  | 'unmark-applied';

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
  };

/** Modes carrying an optional free-text note. Two-step confirm: the first
 *  click only reveals the note input (and a confirm label); the second click
 *  performs the action. */
const NOTE_MODES: Partial<
  Record<Mode, { placeholder: string; confirm: string }>
> = {
  discard: {
    placeholder: 'why? (optional — saved with the discard)',
    confirm: 'Confirm discard',
  },
  'mark-applied': {
    placeholder: 'where/how? (optional)',
    confirm: 'Confirm — mark applied',
  },
};

export function TaskActions({ taskId, mode }: { taskId: string; mode: Mode }) {
  const router = useRouter();
  // Two-step confirm for the note-carrying modes: armed = the input is
  // revealed and the next click really performs the action.
  const [armed, setArmed] = useState(false);
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
    const outcome = await run();
    // The action's revalidatePath alone can leave THIS page's banner/badge
    // stale (the restore-from-archive bug); an explicit client refresh makes
    // every state change land without a manual reload.
    if (outcome.ok) router.refresh();
    return outcome;
  }, null);

  const label = LABELS[mode];
  const noteMode = NOTE_MODES[mode];
  const twoStep = noteMode !== undefined && !armed;
  return (
    <form action={formAction}>
      <div className="row">
        <button
          // Step one only arms the confirm — nothing submits yet.
          type={twoStep ? 'button' : 'submit'}
          disabled={pending}
          className={label.className}
          title={label.title}
          onClick={twoStep ? () => setArmed(true) : undefined}
        >
          {pending
            ? 'Working…'
            : armed && noteMode
              ? noteMode.confirm
              : label.idle}
        </button>
        {noteMode && armed ? (
          <input
            // biome-ignore lint/a11y/noAutofocus: the input appears because the user just clicked the button beside it — focus continues their action
            autoFocus
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
