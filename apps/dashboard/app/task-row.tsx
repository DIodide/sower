'use client';

// One Applications-workspace row: priority stepper (▼/▲, see
// lib/priority-control), label link, plain-words status (tone dot + phrase),
// inline note, relative time, and actions. Recovery actions
// (Retry/Investigate/Restore) are always visible; the destructive Discard
// (with an undo toast), the quiet Mark applied (completed out of band), and
// the bulk-select checkbox are hover/focus-revealed. Rendered as cells of
// the page's CSS grid list — never a <table>.

import type { TaskPriority } from '@sower/core';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import type { Tone } from '../lib/format';
import { InlineNote } from '../lib/inline-note';
import { PriorityControl } from '../lib/priority-control';
import {
  type ActionResult,
  discardTask,
  investigateTask,
  markApplied,
  requeueTask,
  restoreTask,
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
   *  rows, and auto-removed Archive rows read "Auto discarded". */
  phrase: string;
  /** The latest DISCARD event's "why" note, rendered faintly after the
   *  phrase (DISCARDED rows only). */
  statusNote: string | null;
  /** JobSpec.employmentType ("Intern", "Full time") — a faint "· type"
   *  suffix on the status cell; null when unknown or already said by
   *  statusNote. */
  employmentType: string | null;
  /** Unsupported row with no agent currently running — offer Investigate. */
  canInvestigate: boolean;
  /** Compact deadline chip label ("Jul 30"); null = no chip (no deadline,
   *  or a Sent/Archive row where it would be noise). */
  deadline: string | null;
  /** Deadline within 7 days (or past) — the chip gets the red tint. */
  deadlineSoon: boolean;
  /** Precomputed on the server so hydration never disagrees on "now". */
  updatedRel: string;
  updatedAbs: string;
}

/** States the api refuses to discard (terminal, or already left the queue). */
const UNDISCARDABLE = new Set([
  'SUBMITTED',
  'CONFIRMED',
  'DISCARDED',
  'DUPLICATE',
]);

/** Rows offering the quiet "Mark applied" action (completed out of band):
 *  the waiting/processing states only — Sent rows are already applied, and
 *  Archive rows (FAILED/DUPLICATE/DISCARDED) have their own recovery
 *  actions. */
const MARKABLE = new Set([
  'INGESTED',
  'PARSED',
  'QUEUED',
  'PREPARING',
  'NEEDS_INPUT',
  'REVIEW',
  'AWAITING_OTP',
  'FILLING',
]);

/** States where a priority no longer means anything — the control goes inert. */
const PRIORITY_LOCKED = new Set(['SUBMITTED', 'CONFIRMED', 'DISCARDED']);

export function TaskRow({ row }: { row: TaskRowData }) {
  const ws = useWorkspace();
  const router = useRouter();
  const [hidden, setHidden] = useState(false);
  const [busy, setBusy] = useState(false);

  // The in-flight discard, awaited by Undo so restore can't race it.
  const discardRef = useRef<Promise<ActionResult> | null>(null);

  const selectable = !UNDISCARDABLE.has(row.state);
  const priorityLocked = PRIORITY_LOCKED.has(row.state);

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

  // Actions that move the row to another section (Restore → "Waiting on
  // you", Mark applied → Sent): hide the row NOW and say where it went,
  // instead of leaving it visually untouched for the whole server round-trip
  // (which includes the api's Discord reply edit — the "restore looks like
  // it did nothing until I reload" bug). router.refresh() then converges the
  // sections to the server truth; a failure un-hides the row and explains.
  // No undo: neither move is destructive, and both are one click to reverse
  // where reversal exists at all.
  const runMove = (
    action: (id: string) => Promise<ActionResult>,
    doneMessage: string,
    failMessage: string,
  ) => {
    setHidden(true);
    ws.setSelected(row.id, false);
    action(row.id)
      .then((result) => {
        if (result.ok) {
          ws.toast(doneMessage);
          router.refresh();
        } else {
          setHidden(false);
          ws.toast(result.message, { kind: 'error' });
        }
      })
      .catch(() => {
        setHidden(false);
        ws.toast(failMessage, { kind: 'error' });
      });
  };

  if (hidden) return null;

  // Full status wording for the truncation tooltip (the cell may ellipsize).
  const statusTitle =
    row.phrase +
    (row.statusNote ? ` — ${row.statusNote}` : '') +
    (row.employmentType ? ` · ${row.employmentType}` : '') +
    (row.deadline ? ` · deadline ${row.deadline}` : '');

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
        <PriorityControl
          taskId={row.id}
          priority={row.priority}
          disabled={priorityLocked}
          onError={(message) => ws.toast(message, { kind: 'error' })}
        />
      </span>
      <span className="tr-label">
        <span className={`dot dot--${row.tone} tr-dot-narrow`} aria-hidden />
        <Link href={`/tasks/${row.id}`} title={row.label}>
          {row.label}
        </Link>
      </span>
      <span className="tr-status">
        <span className={`dot dot--${row.tone}`} aria-hidden />
        <span className="tr-phrase" title={statusTitle}>
          {row.phrase}
          {row.statusNote ? (
            <span className="faint"> — {row.statusNote}</span>
          ) : null}
          {row.employmentType ? (
            <span className="faint"> · {row.employmentType}</span>
          ) : null}
          {row.deadline ? (
            <span
              className={
                row.deadlineSoon
                  ? 'deadline-chip deadline-chip--soon'
                  : 'deadline-chip'
              }
              title={`Application deadline: ${row.deadline}`}
            >
              ⏰ {row.deadline}
            </span>
          ) : null}
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
              runMove(
                restoreTask,
                'Restored — back in "Waiting on you"',
                'Restore failed — still in the Archive.',
              )
            }
            title="Put this task back in the queue (as needs-input)"
          >
            Restore
          </button>
        ) : null}
        {MARKABLE.has(row.state) ? (
          <button
            type="button"
            className="btn btn--quiet btn--sm tr-reveal"
            disabled={busy}
            onClick={() =>
              runMove(
                markApplied,
                'Marked applied — moved to Sent',
                'Mark applied failed — could not reach the server.',
              )
            }
            title="You applied to this one yourself, outside sower — records it as submitted and moves it to Sent"
          >
            Mark applied
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
