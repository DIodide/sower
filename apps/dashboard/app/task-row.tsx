'use client';

// One Applications-workspace row: priority cycler, label link, plain-words
// status (tone dot + phrase), inline note, relative time, and actions.
// Recovery actions (Retry/Investigate/Restore) are always visible; only the
// destructive Discard (with an undo toast) and the bulk-select checkbox are
// hover/focus-revealed. Rendered as cells of the page's CSS grid list —
// never a <table>.

import { TASK_PRIORITY_LABELS, type TaskPriority } from '@sower/core';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import type { Tone } from '../lib/format';
import { InlineNote } from '../lib/inline-note';
import {
  type ActionResult,
  discardTask,
  investigateTask,
  requeueTask,
  restoreTask,
  updateTaskMeta,
} from './tasks/[id]/actions';
import { useWorkspace } from './workspace';

export interface TaskRowData {
  id: string;
  state: string;
  label: string;
  priority: TaskPriority;
  notes: string | null;
  /** Status dot tone (unsupported rows carry the investigation's tone). */
  tone: Tone;
  /** Plain-words status ("Needs your answers"); the unsupported annotation
   *  ("unsupported site — form discovered") replaces it on unknown-platform
   *  rows. */
  phrase: string;
  /** Unsupported row with no agent currently running — offer Investigate. */
  canInvestigate: boolean;
  /** Precomputed on the server so hydration never disagrees on "now". */
  updatedRel: string;
  updatedAbs: string;
}

/** Click cycle goes UP first: Normal → High → Low → Normal. */
const NEXT_PRIORITY: Record<TaskPriority, TaskPriority> = {
  0: 1,
  1: -1,
  [-1]: 0,
};

const PRIORITY_CLASS: Record<TaskPriority, string> = {
  1: 'pri--high',
  0: 'pri--normal',
  [-1]: 'pri--low',
};

/** States the api refuses to discard (terminal, or already left the queue). */
const UNDISCARDABLE = new Set([
  'SUBMITTED',
  'CONFIRMED',
  'DISCARDED',
  'DUPLICATE',
]);

/** States where a priority no longer means anything — the pip goes inert. */
const PRIORITY_LOCKED = new Set(['SUBMITTED', 'CONFIRMED', 'DISCARDED']);

/** Rapid pip clicks coalesce into one absolute write of the latest value. */
const PRIORITY_DEBOUNCE_MS = 400;

export function TaskRow({ row }: { row: TaskRowData }) {
  const ws = useWorkspace();
  const router = useRouter();
  const [hidden, setHidden] = useState(false);
  const [busy, setBusy] = useState(false);
  // SR-only live announcement ("Priority set to High").
  const [announce, setAnnounce] = useState('');

  // Optimistic priority, reset whenever the server sends a fresh value.
  const [priority, setPriority] = useState(row.priority);
  const [priorityProp, setPriorityProp] = useState(row.priority);
  // Last server-confirmed value — the only rollback target.
  const priBaseRef = useRef(row.priority);
  if (row.priority !== priorityProp) {
    setPriorityProp(row.priority);
    setPriority(row.priority);
    priBaseRef.current = row.priority;
  }
  // Monotonic choice counter: a result only applies if no newer choice (or
  // newer write) happened since it was issued — stale failures are ignored.
  const priSeqRef = useRef(0);
  const priTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The not-yet-written value, flushed (not dropped) on unmount.
  const priPendingRef = useRef<TaskPriority | null>(null);

  useEffect(
    () => () => {
      if (priTimerRef.current) {
        clearTimeout(priTimerRef.current);
        priTimerRef.current = null;
        const pending = priPendingRef.current;
        if (pending !== null) {
          // Unmounting mid-debounce must not lose the chosen priority.
          void updateTaskMeta(row.id, { priority: pending }).catch(() => {});
        }
      }
    },
    [row.id],
  );

  // The in-flight discard, awaited by Undo so restore can't race it.
  const discardRef = useRef<Promise<ActionResult> | null>(null);

  const selectable = !UNDISCARDABLE.has(row.state);
  const priorityLocked = PRIORITY_LOCKED.has(row.state);

  const cyclePriority = () => {
    const next = NEXT_PRIORITY[priority];
    const seq = ++priSeqRef.current;
    setPriority(next);
    setAnnounce(`Priority set to ${TASK_PRIORITY_LABELS[next]}`);
    priPendingRef.current = next;
    if (priTimerRef.current) clearTimeout(priTimerRef.current);
    priTimerRef.current = setTimeout(() => {
      priTimerRef.current = null;
      priPendingRef.current = null;
      updateTaskMeta(row.id, { priority: next })
        .then((result) => {
          if (seq !== priSeqRef.current) return; // a newer choice owns the pip
          if (result.ok) {
            priBaseRef.current = next;
          } else {
            setPriority(priBaseRef.current);
            ws.toast(`Priority not saved — ${result.message}`, {
              kind: 'error',
            });
          }
        })
        .catch(() => {
          if (seq !== priSeqRef.current) return;
          setPriority(priBaseRef.current);
          ws.toast('Priority not saved — could not reach the server.', {
            kind: 'error',
          });
        });
    }, PRIORITY_DEBOUNCE_MS);
  };

  const discard = (viaKeyboard: boolean) => {
    setHidden(true);
    ws.setSelected(row.id, false);
    // Network failures collapse into a not-ok result so every consumer
    // (the failure toast below, the Undo handler) sees one shape.
    const promise = discardTask(row.id).catch(
      (): ActionResult => ({
        ok: false,
        message: 'Discard failed — could not reach the server.',
      }),
    );
    discardRef.current = promise;
    ws.toast('Discarded — Undo returns it to "Waiting on you"', {
      focusUndo: viaKeyboard,
      onUndo: async () => {
        // Only restore what was actually discarded: await the discard and
        // bail if it failed (the failure handler already un-hid the row).
        const discarded = await discardRef.current;
        if (discarded && !discarded.ok) {
          router.refresh();
          return;
        }
        try {
          const result = await restoreTask(row.id);
          if (result.ok) setHidden(false);
          else ws.toast(result.message, { kind: 'error' });
        } catch {
          ws.toast('Restore failed — check the Archive.', { kind: 'error' });
        }
        router.refresh();
      },
      onExpire: () => router.refresh(),
    });
    void promise.then((result) => {
      if (!result.ok) {
        setHidden(false);
        ws.toast(result.message, { kind: 'error' });
      }
    });
  };

  const runAction = (
    action: (id: string) => Promise<ActionResult>,
    failMessage: string,
  ) => {
    setBusy(true);
    action(row.id)
      .then((result) => {
        ws.toast(result.message, { kind: result.ok ? 'info' : 'error' });
        router.refresh();
      })
      .catch(() => {
        ws.toast(failMessage, { kind: 'error' });
      })
      .finally(() => {
        setBusy(false);
      });
  };

  if (hidden) return null;

  const priorityLabel = TASK_PRIORITY_LABELS[priority];

  return (
    <div className="grid-row">
      <span className="tr-check">
        {selectable ? (
          <input
            type="checkbox"
            checked={ws.isSelected(row.id)}
            onChange={(e) => ws.setSelected(row.id, e.target.checked)}
            aria-label={`Select ${row.label}`}
          />
        ) : null}
      </span>
      <span className="tr-pri">
        <button
          type="button"
          className={`pri ${PRIORITY_CLASS[priority]}`}
          disabled={priorityLocked}
          onClick={cyclePriority}
          aria-label={
            priorityLocked
              ? `Priority: ${priorityLabel}`
              : `Priority: ${priorityLabel} — click to change`
          }
          title={
            priorityLocked
              ? `Priority: ${priorityLabel}`
              : `Priority: ${priorityLabel} — click to change`
          }
        />
        <span aria-live="polite" className="sr-only">
          {announce}
        </span>
      </span>
      <span className="tr-label">
        <span className={`dot dot--${row.tone} tr-dot-narrow`} aria-hidden />
        <Link href={`/tasks/${row.id}`} title={row.label}>
          {row.label}
        </Link>
      </span>
      <span className="tr-status">
        <span className={`dot dot--${row.tone}`} aria-hidden />
        <span className="tr-phrase" title={row.phrase}>
          {row.phrase}
        </span>
      </span>
      <span className="tr-note">
        <InlineNote taskId={row.id} note={row.notes} />
      </span>
      <span className="tr-when" title={row.updatedAbs}>
        {row.updatedRel}
      </span>
      <span className="tr-actions">
        {row.state === 'FAILED' ? (
          <button
            type="button"
            className="btn btn--quiet btn--sm"
            disabled={busy}
            onClick={() =>
              runAction(
                requeueTask,
                'Retry failed — could not reach the server.',
              )
            }
            title="Requeue this task for another attempt"
          >
            {busy ? 'Working…' : 'Retry'}
          </button>
        ) : null}
        {row.canInvestigate ? (
          <button
            type="button"
            className="btn btn--quiet btn--sm"
            disabled={busy}
            onClick={() =>
              runAction(
                investigateTask,
                'Investigate failed — could not reach the server.',
              )
            }
            title="Start the form-discovery browser agent on this job's page"
          >
            {busy ? 'Working…' : 'Investigate'}
          </button>
        ) : null}
        {row.state === 'DISCARDED' ? (
          <button
            type="button"
            className="btn btn--quiet btn--sm"
            disabled={busy}
            onClick={() =>
              runAction(
                restoreTask,
                'Restore failed — could not reach the server.',
              )
            }
            title="Put this task back in the queue (as needs-input)"
          >
            {busy ? 'Working…' : 'Restore'}
          </button>
        ) : null}
        {selectable ? (
          <button
            type="button"
            className="btn btn--danger btn--sm tr-reveal"
            onClick={(e) => discard(e.detail === 0)}
            title="Remove this task from the queue (the record is kept)"
          >
            Discard
          </button>
        ) : null}
      </span>
    </div>
  );
}
