'use client';

// Inline user due-date editor: the ⏰ chip on Applications rows ('chip'
// variant) and the task header's Deadline cell ('cell' variant). Displays
// whichever date applies — the USER'S own due date wins over the posting's
// parsed deadline (lib/deadline pickDeadline); the two render identically,
// only the tooltip says which ("your due date" vs "posting deadline"). On
// actionable rows a click opens a tiny popover with a native date input +
// Clear. Writes are optimistic and debounced (a native date input fires
// change per segment while a date is typed); a stale failure rolls back to
// the last server-confirmed value and reports via `onError` (the row's toast
// layer) or a small inline message. Setting or clearing the user date NEVER
// touches jobs.deadline — the posting's value simply resurfaces on clear.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ActionResult } from '../app/tasks/[id]/actions';
import { updateTaskMeta } from '../app/tasks/[id]/actions';
import { deadlineChipLabel, formatDeadline, isDeadlineSoon } from './format';

/** Segment-typed dates coalesce into one absolute write of the final value. */
const DUE_DEBOUNCE_MS = 500;

export interface DueDateDisplay {
  /** Precomputed on the server so hydration never disagrees on "now". */
  label: string;
  /** Within 7 days (or past) — red tint. */
  soon: boolean;
  /** Which date this is: the user's own, or the posting's parsed one. */
  kind: 'user' | 'posting';
}

function tooltip(display: DueDateDisplay | null, editable: boolean): string {
  if (!display) return 'Set a due date';
  const base =
    display.kind === 'user'
      ? `Your due date: ${display.label}`
      : `Posting deadline: ${display.label}`;
  return editable ? `${base} — click to edit your due date` : base;
}

export function DueDateControl({
  taskId,
  display,
  dueDateISO,
  fallback,
  editable,
  variant = 'chip',
  onError,
  saveAction,
}: {
  /** The row this date belongs to — a task id by default; with `saveAction`
   *  set it is only an identity key (e.g. a follow-up id). */
  taskId: string;
  /** Current display (user date wins), or null when neither date exists. */
  display: DueDateDisplay | null;
  /** The user's own date as yyyy-mm-dd (the date input's value), or null. */
  dueDateISO: string | null;
  /** Posting-deadline display that resurfaces when the user date clears. */
  fallback: { label: string; soon: boolean } | null;
  /** Waiting-on-you / incoming rows only; elsewhere the value is static. */
  editable: boolean;
  /** 'chip' = row ⏰ chip; 'cell' = task-header Deadline cell. */
  variant?: 'chip' | 'cell';
  /** Failure sink (the row's toast layer). Omitted = inline message. */
  onError?: (message: string) => void;
  /** Alternate persistence target (e.g. a bound follow-up patch action).
   *  Default: the task-meta action keyed by `taskId`. */
  saveAction?: (dueDate: string | null) => Promise<ActionResult>;
}) {
  // Optimistic user date, reset whenever the server sends a fresh value.
  const [value, setValue] = useState(dueDateISO);
  const [prevProp, setPrevProp] = useState(dueDateISO);
  const [open, setOpen] = useState(false);
  const [announce, setAnnounce] = useState('');
  const [inlineError, setInlineError] = useState<string | null>(null);
  // Last server-confirmed value — the only rollback target.
  const baseRef = useRef(dueDateISO);
  if (dueDateISO !== prevProp) {
    setPrevProp(dueDateISO);
    setValue(dueDateISO);
    baseRef.current = dueDateISO;
  }
  // Persistence target (default: the task-meta action), mirrored into a ref
  // so the unmount flush (deps: [taskId] only) always calls the latest.
  const persist = (next: string | null) =>
    saveAction ? saveAction(next) : updateTaskMeta(taskId, { dueDate: next });
  const persistRef = useRef(persist);
  persistRef.current = persist;
  // Monotonic choice counter: stale failures never clobber a newer choice.
  const seqRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The not-yet-written value, flushed (not dropped) on unmount.
  const pendingRef = useRef<string | null | undefined>(undefined);
  // The chip/cell button, refocused when Escape closes the popover.
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  // The floating popover, for the viewport clamp below.
  const popRef = useRef<HTMLSpanElement | null>(null);
  // Was the popover open when the chip's mousedown fired? Clicking the chip
  // while open blurs the input FIRST (which already closes the popover), so
  // a plain onClick toggle would reopen it — this snapshot records what the
  // click actually meant.
  const mouseDownWhileOpenRef = useRef(false);

  // Keep the popover on-screen: shift it left when it would overflow the
  // right viewport edge (it opens left-aligned under the chip, which can sit
  // near the edge), never past the left one.
  useLayoutEffect(() => {
    if (!open) return;
    const el = popRef.current;
    if (!el) return;
    el.style.left = '0px';
    const rect = el.getBoundingClientRect();
    const margin = 8;
    let shift = Math.min(0, window.innerWidth - margin - rect.right);
    shift = Math.max(shift, margin - rect.left);
    if (shift !== 0) el.style.left = `${shift}px`;
  }, [open]);

  useEffect(
    () => () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
        const pending = pendingRef.current;
        if (pending !== undefined) {
          // Unmounting mid-debounce must not lose the chosen date.
          void persistRef.current(pending).catch(() => {});
        }
      }
    },
    [],
  );

  const fail = (message: string) => {
    if (onError) onError(message);
    else setInlineError(message);
  };

  const schedule = (next: string | null) => {
    const seq = ++seqRef.current;
    setValue(next);
    setInlineError(null);
    setAnnounce(
      next ? `Due date set to ${formatDeadline(next)}` : 'Due date cleared',
    );
    pendingRef.current = next;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      pendingRef.current = undefined;
      persistRef
        .current(next)
        .then((result) => {
          if (seq !== seqRef.current) return; // a newer choice owns the control
          if (result.ok) {
            baseRef.current = next;
          } else {
            setValue(baseRef.current);
            fail(`Due date not saved — ${result.message}`);
          }
        })
        .catch(() => {
          if (seq !== seqRef.current) return;
          setValue(baseRef.current);
          fail('Due date not saved — could not reach the server.');
        });
    }, DUE_DEBOUNCE_MS);
  };

  // What to show right now: the server's precomputed display while the value
  // is server-truth; a locally computed one after an optimistic edit.
  const current: DueDateDisplay | null =
    value === dueDateISO
      ? display
      : value
        ? {
            label:
              variant === 'cell'
                ? formatDeadline(value)
                : (deadlineChipLabel(value) ?? value),
            soon: isDeadlineSoon(value),
            kind: 'user',
          }
        : fallback
          ? { ...fallback, kind: 'posting' }
          : null;

  const title = tooltip(current, editable);

  // Static (non-editable) rendering — nothing to click, nothing when empty.
  if (!editable) {
    if (!current) return null;
    if (variant === 'cell') {
      return (
        <span
          className={
            current.kind === 'posting' && !current.soon ? 'faint' : undefined
          }
          style={current.soon ? { color: 'var(--danger-fg)' } : undefined}
          title={title}
        >
          {current.label}
        </span>
      );
    }
    return (
      <span
        className={
          current.soon ? 'deadline-chip deadline-chip--soon' : 'deadline-chip'
        }
        title={title}
      >
        ⏰ {current.label}
      </span>
    );
  }

  const chipClasses = [
    'deadline-chip',
    'due-btn',
    current?.soon ? 'deadline-chip--soon' : '',
    current === null ? 'due-ghost' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <span
      className={variant === 'cell' ? 'due-wrap due-wrap--cell' : 'due-wrap'}
    >
      <button
        ref={buttonRef}
        type="button"
        className={variant === 'cell' ? 'due-cell-btn' : chipClasses}
        aria-expanded={open}
        aria-label={title}
        title={title}
        onMouseDown={() => {
          mouseDownWhileOpenRef.current = open;
        }}
        onClick={() => {
          // A click that STARTED while the popover was open always closes it
          // (the input's blur already set open=false; toggling would reopen).
          if (mouseDownWhileOpenRef.current) {
            mouseDownWhileOpenRef.current = false;
            setOpen(false);
          } else {
            setOpen((wasOpen) => !wasOpen);
          }
        }}
      >
        {variant === 'cell' ? (
          current ? (
            <span
              className={
                current.kind === 'posting' && !current.soon
                  ? 'faint'
                  : undefined
              }
              style={current.soon ? { color: 'var(--danger-fg)' } : undefined}
            >
              {current.label}
            </span>
          ) : (
            <span className="due-ghost-cell">Set due date…</span>
          )
        ) : current ? (
          `⏰ ${current.label}`
        ) : (
          '⏰'
        )}
      </button>
      {open ? (
        // biome-ignore lint/a11y/noStaticElementInteractions: onBlur/onKeyDown here are focus-loss and Escape plumbing for the popover as a whole, not interactivity — the input and Clear button inside are the interactive elements
        <span
          ref={popRef}
          className="due-pop"
          onBlur={(event) => {
            // Close when focus leaves the popover entirely.
            if (!event.currentTarget.contains(event.relatedTarget as Node)) {
              setOpen(false);
            }
          }}
          onKeyDown={(event) => {
            // Escape closes from ANY element inside (input, Clear, …) and
            // returns focus to the chip so it isn't dropped on <body>.
            if (event.key === 'Escape') {
              event.preventDefault();
              setOpen(false);
              buttonRef.current?.focus();
            }
          }}
        >
          <input
            // biome-ignore lint/a11y/noAutofocus: the user just clicked the chip to type a date — focus continues their action in place
            autoFocus
            type="date"
            className="field due-input"
            aria-label="Your due date"
            value={value ?? ''}
            onChange={(event) =>
              schedule(event.target.value === '' ? null : event.target.value)
            }
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                setOpen(false);
              }
            }}
          />
          <button
            type="button"
            className="btn btn--quiet btn--sm"
            disabled={value === null}
            title="Remove your due date (the posting's own deadline, if any, shows again)"
            onClick={() => {
              schedule(null);
              setOpen(false);
            }}
          >
            Clear
          </button>
        </span>
      ) : null}
      <span aria-live="polite" className="sr-only">
        {announce}
      </span>
      {inlineError ? (
        <span role="status" className="status-err due-err">
          {inlineError}
        </span>
      ) : null}
    </span>
  );
}
