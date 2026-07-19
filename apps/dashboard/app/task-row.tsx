'use client';

// One Applications-workspace row: priority stepper (▼/▲, see
// lib/priority-control), label link, plain-words status (tone dot + phrase),
// due-date ⏰ chip (click-to-edit on actionable rows), inline note, relative
// time, and actions. Recovery actions (Retry/Investigate/Restore) and the
// Un-mark applied undo are always visible; the destructive Discard (with an
// undo toast) and the bulk-select checkbox are hover/focus-revealed. "Mark
// applied" lives on the detail page only — rows keep grip/checkbox/clock/
// note/Discard. "Waiting on you" rows additionally carry a drag grip (⋮⋮)
// wired by the section's OrderedList; a hand-ranked row's grip stays faintly
// visible as the cue that a manual order exists. Rendered as cells of the
// page's CSS grid list — never a <table>.

import type { TaskPriority } from '@sower/core';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { DueDateControl, type DueDateDisplay } from '../lib/due-date-control';
import { PRIORITY_LOCKED, SECTIONS, type Tone } from '../lib/format';
import { InlineNote } from '../lib/inline-note';
import { PriorityControl } from '../lib/priority-control';
import {
  type ActionResult,
  discardTask,
  investigateTask,
  requeueTask,
  restoreTask,
  unmarkApplied,
} from './tasks/[id]/actions';
import { useWorkspace } from './workspace';

/** Wiring the OrderedList gives a "Waiting on you" row: its position, the
 *  drag/drop handlers, and the keyboard move. Absent on every other row. */
export interface RowReorder {
  index: number;
  count: number;
  /** This row is the one currently being dragged. */
  dragging: boolean;
  /** Insertion-line side to highlight while a drag hovers this row. */
  dropEdge: 'above' | 'below' | null;
  onDragStart: (index: number, event: React.DragEvent<HTMLElement>) => void;
  onDragEnd: () => void;
  onDragOver: (index: number, event: React.DragEvent<HTMLElement>) => void;
  onDrop: (index: number, event: React.DragEvent<HTMLElement>) => void;
  /** Keyboard: move one position up (-1) or down (1). */
  onMove: (index: number, direction: -1 | 1) => void;
}

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
   *  suffix on the label line (metadata with metadata); null when unknown
   *  or already said by statusNote. */
  employmentType: string | null;
  /** This row holds a manual "Waiting on you" drag rank — its grip stays
   *  faintly visible as the cue that a hand-made order exists. */
  ranked: boolean;
  /** Arrival time (created_at, epoch ms) — the sort key the unranked block
   *  and "New & processing" order by (see lib/reorder compareWaiting). */
  createdAtMs: number;
  /** Unsupported row with no agent currently running — offer Investigate. */
  canInvestigate: boolean;
  /** SUBMITTED via an out-of-band "Mark applied" (not a real sower submit) —
   *  offer the quiet Un-mark applied undo. */
  canUnmark: boolean;
  /** ⏰ chip display: the user's own due date when set, else the posting's
   *  parsed deadline; null = neither (or a Sent/Archive row — noise there).
   *  Labels precomputed on the server so hydration never disagrees. */
  deadline: DueDateDisplay | null;
  /** The user's own due date (yyyy-mm-dd) for the chip's date input. */
  dueDateISO: string | null;
  /** Posting-deadline display that resurfaces if the user date is cleared. */
  deadlineFallback: { label: string; soon: boolean } | null;
  /** Chip is click-to-edit on Waiting-on-you / New & processing rows. */
  deadlineEditable: boolean;
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

export function TaskRow({
  row,
  reorder,
}: {
  row: TaskRowData;
  /** Present only inside the "Waiting on you" OrderedList. */
  reorder?: RowReorder;
}) {
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
    ws.toast(`Discarded — Undo returns it to "${SECTIONS.waiting}"`, {
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
  // Only what THIS cell shows: the ⏰ chip and the type suffix carry their
  // own tooltips, so repeating them here read twice.
  const statusTitle =
    row.phrase + (row.statusNote ? ` — ${row.statusNote}` : '');
  const labelTitle = row.employmentType
    ? `${row.label} · ${row.employmentType}`
    : row.label;

  const rowClass = [
    'grid-row',
    reorder ? 'grid-row--grip' : '',
    reorder?.dragging ? 'grid-row--dragging' : '',
    reorder?.dropEdge === 'above' ? 'grid-row--drop-above' : '',
    reorder?.dropEdge === 'below' ? 'grid-row--drop-below' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: dragover/drop are pointer-only plumbing for the grip's HTML5 drag — the keyboard path is the grip button's arrow keys
    <div
      className={rowClass}
      onDragOver={
        reorder
          ? (event) => reorder.onDragOver(reorder.index, event)
          : undefined
      }
      onDrop={
        reorder ? (event) => reorder.onDrop(reorder.index, event) : undefined
      }
    >
      {reorder ? (
        <span className={row.ranked ? 'tr-grip tr-grip--ranked' : 'tr-grip'}>
          <button
            type="button"
            className="tr-grip-btn"
            draggable
            aria-label={`Reorder ${row.label} — position ${reorder.index + 1} of ${reorder.count}; press arrow up or down to move`}
            title="Drag to reorder (or focus and press ↑/↓)"
            onDragStart={(event) => reorder.onDragStart(reorder.index, event)}
            onDragEnd={reorder.onDragEnd}
            onKeyDown={(event) => {
              if (event.key === 'ArrowUp') {
                event.preventDefault();
                reorder.onMove(reorder.index, -1);
              } else if (event.key === 'ArrowDown') {
                event.preventDefault();
                reorder.onMove(reorder.index, 1);
              }
            }}
          >
            ⋮⋮
          </button>
        </span>
      ) : null}
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
        <Link href={`/tasks/${row.id}`} title={labelTitle}>
          {row.label}
        </Link>
        {/* Faint "· Intern" — job metadata rides the job's label line. */}
        {row.employmentType ? (
          <span className="faint tr-type" title={row.employmentType}>
            {' '}
            · {row.employmentType}
          </span>
        ) : null}
      </span>
      <span className="tr-status">
        <span className={`dot dot--${row.tone}`} aria-hidden />
        <span className="tr-phrase" title={statusTitle}>
          {row.phrase}
          {row.statusNote ? (
            <span className="faint"> — {row.statusNote}</span>
          ) : null}
        </span>
        {/* ⏰ chip — sibling of the phrase so its popover never clips on the
            phrase's ellipsis overflow. Editable rows with neither date show
            a ghost ⏰ affordance on hover (like Add note…). */}
        <DueDateControl
          taskId={row.id}
          display={row.deadline}
          dueDateISO={row.dueDateISO}
          fallback={row.deadlineFallback}
          editable={row.deadlineEditable}
          onError={(message) => ws.toast(message, { kind: 'error' })}
        />
      </span>
      <span className="tr-note">
        {/* Same editability rule as the detail header: terminal tasks read-only. */}
        <InlineNote
          taskId={row.id}
          note={row.notes}
          readOnly={priorityLocked}
        />
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
            title={`Requeue this task for another attempt — moves to "${SECTIONS.processing}"`}
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
                `Restored — back in "${SECTIONS.waiting}"`,
                'Restore failed — still in the Archive.',
              )
            }
            title={`Put this task back in "${SECTIONS.waiting}"`}
          >
            Restore
          </button>
        ) : null}
        {row.canUnmark ? (
          <button
            type="button"
            className="btn btn--quiet btn--sm"
            disabled={busy}
            onClick={() =>
              runMove(
                unmarkApplied,
                `Back in "${SECTIONS.waiting}"`,
                'Un-mark failed — could not reach the server.',
              )
            }
            title={`"Mark applied" was a mistake — moves this back in "${SECTIONS.waiting}"`}
          >
            Un-mark applied
          </button>
        ) : null}
        {selectable ? (
          <button
            type="button"
            className="btn btn--danger btn--sm tr-reveal"
            onClick={(e) => discard(e.detail === 0)}
            title="Moves this task to the Archive (the record and history are kept; Restore brings it back)"
          >
            Discard
          </button>
        ) : null}
      </span>
    </div>
  );
}
