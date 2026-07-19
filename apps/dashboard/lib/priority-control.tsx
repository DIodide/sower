'use client';

// Compact priority stepper shared by the Applications rows and the task
// detail header: ▼ lowers, ▲ raises — one click is one step in an obvious
// direction — with a micro level indicator between them ("High"/"Low";
// Normal stays visually quiet as an en dash, and the top "Highest" level
// renders as a filled danger-toned chip so it reads stronger than High's
// amber at a glance). ▲ from High reaches Highest and is disabled there.
// Writes are optimistic and
// coalesced: rapid clicks debounce into ONE absolute write of the final
// value; a stale failure rolls back to the last server-confirmed value and
// never clobbers a newer choice. `onError` routes failures to the caller's
// surface (the row's toast layer); without it a small inline message renders.

import { TASK_PRIORITY_LABELS, type TaskPriority } from '@sower/core';
import { useEffect, useRef, useState } from 'react';
import { updateTaskMeta } from '../app/tasks/[id]/actions';
import { PRIORITY_MAX, PRIORITY_MIN, stepPriority } from './priority';

/** Rapid stepper clicks coalesce into one absolute write of the latest value. */
const PRIORITY_DEBOUNCE_MS = 400;

const LEVEL_CLASS: Record<TaskPriority, string> = {
  2: 'pri-level--highest',
  1: 'pri-level--high',
  0: 'pri-level--normal',
  [-1]: 'pri-level--low',
};

export function PriorityControl({
  taskId,
  priority: priorityProp,
  disabled = false,
  onError,
}: {
  taskId: string;
  priority: TaskPriority;
  /** Sent/discarded tasks: the level stays legible, the steppers go inert. */
  disabled?: boolean;
  /** Failure sink (e.g. the workspace toast). Omitted = inline message. */
  onError?: (message: string) => void;
}) {
  // Optimistic priority, reset whenever the server sends a fresh value.
  const [priority, setPriority] = useState(priorityProp);
  const [prevProp, setPrevProp] = useState(priorityProp);
  // SR-only live announcement ("Priority set to High").
  const [announce, setAnnounce] = useState('');
  const [inlineError, setInlineError] = useState<string | null>(null);
  // Last server-confirmed value — the only rollback target.
  const baseRef = useRef(priorityProp);
  if (priorityProp !== prevProp) {
    setPrevProp(priorityProp);
    setPriority(priorityProp);
    baseRef.current = priorityProp;
  }
  // Monotonic choice counter: a result only applies if no newer choice (or
  // newer write) happened since it was issued — stale failures are ignored.
  const seqRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The not-yet-written value, flushed (not dropped) on unmount.
  const pendingRef = useRef<TaskPriority | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
        const pending = pendingRef.current;
        if (pending !== null) {
          // Unmounting mid-debounce must not lose the chosen priority.
          void updateTaskMeta(taskId, { priority: pending }).catch(() => {});
        }
      }
    },
    [taskId],
  );

  const fail = (message: string) => {
    if (onError) onError(message);
    else setInlineError(message);
  };

  const step = (direction: 1 | -1) => {
    // In-bounds by construction: the button at each end is disabled (and
    // stepPriority clamps at the stops regardless).
    const next = stepPriority(priority, direction);
    if (next === priority) return;
    const seq = ++seqRef.current;
    setPriority(next);
    setInlineError(null);
    setAnnounce(`Priority set to ${TASK_PRIORITY_LABELS[next]}`);
    pendingRef.current = next;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      pendingRef.current = null;
      updateTaskMeta(taskId, { priority: next })
        .then((result) => {
          if (seq !== seqRef.current) return; // a newer choice owns the control
          if (result.ok) {
            baseRef.current = next;
          } else {
            setPriority(baseRef.current);
            fail(`Priority not saved — ${result.message}`);
          }
        })
        .catch(() => {
          if (seq !== seqRef.current) return;
          setPriority(baseRef.current);
          fail('Priority not saved — could not reach the server.');
        });
    }, PRIORITY_DEBOUNCE_MS);
  };

  const label = TASK_PRIORITY_LABELS[priority];

  return (
    // biome-ignore lint/a11y/useSemanticElements: a <fieldset> cannot nest inside the row's phrasing-content <span> cells; role="group" carries the same semantics without breaking the markup
    <span
      className={disabled ? 'pri-ctl pri-ctl--locked' : 'pri-ctl'}
      role="group"
      aria-label={`Priority: ${label}`}
    >
      <button
        type="button"
        className="pri-step"
        disabled={disabled || priority === PRIORITY_MIN}
        onClick={() => step(-1)}
        aria-label="Lower priority"
        title="Lower priority"
      >
        ▼
      </button>
      <span
        className={`pri-level ${LEVEL_CLASS[priority]}`}
        title={`Priority: ${label}`}
        aria-hidden
      >
        {priority === 0 ? '–' : label}
      </span>
      <button
        type="button"
        className="pri-step"
        disabled={disabled || priority === PRIORITY_MAX}
        onClick={() => step(1)}
        aria-label="Raise priority"
        title="Raise priority"
      >
        ▲
      </button>
      <span aria-live="polite" className="sr-only">
        {announce}
      </span>
      {inlineError ? (
        <span role="status" className="status-err pri-err">
          {inlineError}
        </span>
      ) : null}
    </span>
  );
}
