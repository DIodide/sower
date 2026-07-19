'use client';

// Inline, always-in-place note editing for task rows (shared so the task
// detail page can reuse it later). Display mode shows the note's first line
// faint — or a ghost "Add note…" that appears on row hover/focus (always on
// touch). Click to edit in a borderless, autogrowing textarea; saves via
// updateTaskMeta on blur and on an 800ms typing debounce. Escape reverts to
// the value the edit session STARTED with (and rolls the server back if a
// debounce checkpoint already landed). Unmount FLUSHES a pending save rather
// than dropping it; a dirty-but-unsaved state shows a subtle "…".

import { useEffect, useRef, useState } from 'react';
import { updateTaskMeta } from '../app/tasks/[id]/actions';

const DEBOUNCE_MS = 800;
const FLASH_MS = 1_500;
/** Mirrors the api's notes cap — checked here so the error is instant. */
const NOTE_MAX_CHARS = 20_000;

/** JS autogrow fallback for browsers without `field-sizing: content`. */
function autogrow(el: HTMLTextAreaElement): void {
  if (typeof CSS !== 'undefined' && CSS.supports('field-sizing', 'content')) {
    return; // the stylesheet already handles it
  }
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight}px`; // CSS max-height caps this
}

export function InlineNote({
  taskId,
  note,
}: {
  taskId: string;
  note: string | null;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(note ?? '');
  // What the server currently has, as state so the dirty "…" can render.
  const [savedValue, setSavedValue] = useState(note ?? '');
  const [flash, setFlash] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Refs mirroring the above for closures that outlive a render (debounce
  // timers, the unmount flush).
  const savedRef = useRef(note ?? '');
  const valueRef = useRef(note ?? '');
  // Escape target: the value when THIS edit session began (not the last
  // debounce checkpoint).
  const sessionStartRef = useRef(note ?? '');
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flashRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (flashRef.current) clearTimeout(flashRef.current);
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
        // FLUSH the pending save — unmounting must never lose typed text.
        const trimmed = valueRef.current.trim();
        if (
          trimmed !== savedRef.current.trim() &&
          trimmed.length <= NOTE_MAX_CHARS
        ) {
          void updateTaskMeta(taskId, {
            notes: trimmed === '' ? null : trimmed,
          }).catch(() => {});
        }
      }
    },
    [taskId],
  );

  const save = (next: string) => {
    const trimmed = next.trim();
    if (trimmed === savedRef.current.trim()) return;
    // Client-side length check: the real message, before any network call.
    if (trimmed.length > NOTE_MAX_CHARS) {
      setError('note is too long (max 20,000 characters)');
      return;
    }
    updateTaskMeta(taskId, { notes: trimmed === '' ? null : trimmed })
      .then((result) => {
        if (result.ok) {
          savedRef.current = trimmed;
          setSavedValue(trimmed);
          setError(null);
          setFlash(true);
          if (flashRef.current) clearTimeout(flashRef.current);
          flashRef.current = setTimeout(() => setFlash(false), FLASH_MS);
        } else {
          // Keep the text (rollback would destroy it); surface the failure.
          setError(result.message);
        }
      })
      .catch(() => {
        setError('not saved — could not reach the server; your text is safe.');
      });
  };

  const onChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    const next = event.target.value;
    setValue(next);
    valueRef.current = next;
    autogrow(event.target);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      debounceRef.current = null;
      save(next);
    }, DEBOUNCE_MS);
  };

  const onBlur = () => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    save(value);
    setEditing(false);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
      const snapshot = sessionStartRef.current;
      setValue(snapshot);
      valueRef.current = snapshot;
      // A mid-session debounce may already have written; roll the server
      // back to the session-start value too (no-op if nothing was written).
      save(snapshot);
      setEditing(false);
    }
  };

  const startEditing = () => {
    sessionStartRef.current = value;
    setEditing(true);
  };

  const dirty = value.trim() !== savedValue.trim();

  const indicators = (
    <>
      {dirty && error === null ? (
        <span className="note-dirty" title="not saved yet">
          …
        </span>
      ) : null}
      {flash && !dirty ? <span className="note-saved">Saved ✓</span> : null}
      {error ? <span className="status-err note-err">{error}</span> : null}
    </>
  );

  if (editing) {
    return (
      <span className="note-wrap">
        <textarea
          // biome-ignore lint/a11y/noAutofocus: the user just clicked this exact spot to type — focus continues their action in place
          autoFocus
          ref={(el) => {
            if (el) autogrow(el);
          }}
          className="note-edit"
          rows={1}
          value={value}
          placeholder="Add note…"
          aria-label="Task note"
          onChange={onChange}
          onBlur={onBlur}
          onKeyDown={onKeyDown}
        />
        {indicators}
      </span>
    );
  }

  const firstLine = value.split('\n', 1)[0] ?? '';
  return (
    <span className="note-wrap">
      <button
        type="button"
        className={firstLine === '' ? 'note-btn note-ghost' : 'note-btn'}
        onClick={startEditing}
        title={value !== '' ? value : 'Add a note'}
      >
        {firstLine === '' ? 'Add note…' : firstLine}
      </button>
      {indicators}
    </span>
  );
}
