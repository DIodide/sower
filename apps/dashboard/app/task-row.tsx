'use client';

// One Applications-workspace row: priority cycler, label link, plain-words
// status (tone dot + phrase), inline note, relative time, and hover-revealed
// actions (Discard with an undo toast, Investigate/Retry/Restore where they
// apply) plus the bulk-select checkbox. Rendered as cells of the page's CSS
// grid list — never a <table>.

import { TASK_PRIORITY_LABELS, type TaskPriority } from '@sower/core';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
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

/** Click cycle: High → Normal → Low → High. */
const NEXT_PRIORITY: Record<TaskPriority, TaskPriority> = {
  1: 0,
  0: -1,
  [-1]: 1,
};

const PRIORITY_CLASS: Record<TaskPriority, string> = {
  1: 'pri--high',
  0: 'pri--normal',
  [-1]: 'pri--low',
};

/** States the api refuses to discard (or that already left the queue). */
const UNDISCARDABLE = new Set(['SUBMITTED', 'CONFIRMED', 'DISCARDED']);

export function TaskRow({ row }: { row: TaskRowData }) {
  const ws = useWorkspace();
  const router = useRouter();
  const [hidden, setHidden] = useState(false);
  const [busy, setBusy] = useState(false);

  // Optimistic priority, reset whenever the server sends a fresh value.
  const [priority, setPriority] = useState(row.priority);
  const [priorityProp, setPriorityProp] = useState(row.priority);
  if (row.priority !== priorityProp) {
    setPriorityProp(row.priority);
    setPriority(row.priority);
  }

  // The in-flight discard, awaited by Undo so restore can't race it.
  const discardRef = useRef<Promise<ActionResult> | null>(null);

  const selectable = !UNDISCARDABLE.has(row.state);

  const cyclePriority = () => {
    const prev = priority;
    const next = NEXT_PRIORITY[prev];
    setPriority(next);
    void updateTaskMeta(row.id, { priority: next }).then((result) => {
      if (!result.ok) {
        setPriority(prev);
        ws.toast(`Priority not saved — ${result.message}`);
      }
    });
  };

  const discard = () => {
    setHidden(true);
    ws.setSelected(row.id, false);
    const promise = discardTask(row.id);
    discardRef.current = promise;
    ws.toast('Discarded', {
      onUndo: async () => {
        await discardRef.current;
        const result = await restoreTask(row.id);
        if (result.ok) setHidden(false);
        else ws.toast(result.message);
        router.refresh();
      },
      onExpire: () => router.refresh(),
    });
    void promise.then((result) => {
      if (!result.ok) {
        setHidden(false);
        ws.toast(result.message);
      }
    });
  };

  const runAction = (action: (id: string) => Promise<ActionResult>) => {
    setBusy(true);
    void action(row.id).then((result) => {
      setBusy(false);
      ws.toast(result.message);
      router.refresh();
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
          onClick={cyclePriority}
          aria-label={`Priority: ${priorityLabel} — click to change`}
          title={`Priority: ${priorityLabel} — click to change`}
        />
      </span>
      <span className="tr-label">
        <span className={`dot dot--${row.tone} tr-dot-narrow`} aria-hidden />
        <Link href={`/tasks/${row.id}`}>{row.label}</Link>
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
            className="btn btn--sm"
            disabled={busy}
            onClick={() => runAction(requeueTask)}
            title="Requeue this task for another attempt"
          >
            {busy ? 'Working…' : 'Retry'}
          </button>
        ) : null}
        {row.canInvestigate ? (
          <button
            type="button"
            className="btn btn--primary btn--sm"
            disabled={busy}
            onClick={() => runAction(investigateTask)}
            title="Start the form-discovery browser agent on this job's page"
          >
            {busy ? 'Working…' : 'Investigate'}
          </button>
        ) : null}
        {row.state === 'DISCARDED' ? (
          <button
            type="button"
            className="btn btn--sm"
            disabled={busy}
            onClick={() => runAction(restoreTask)}
            title="Put this task back in the queue (as needs-input)"
          >
            {busy ? 'Working…' : 'Restore'}
          </button>
        ) : null}
        {selectable ? (
          <button
            type="button"
            className="btn btn--danger btn--sm"
            onClick={discard}
            title="Remove this task from the queue (the record is kept)"
          >
            Discard
          </button>
        ) : null}
      </span>
    </div>
  );
}
