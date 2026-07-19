'use client';

// Inline, always-in-place note editing for task rows (shared so the task
// detail page can reuse it later). Display mode shows the note's first line
// faint — or a ghost "Add note…" that appears on row hover/focus (always on
// touch). Click to edit in a borderless textarea; saves via updateTaskMeta on
// blur and on an 800ms typing debounce; Escape reverts. No modal, no button.

import { useEffect, useRef, useState } from 'react';
import { updateTaskMeta } from '../app/tasks/[id]/actions';

const DEBOUNCE_MS = 800;
const FLASH_MS = 1_500;

export function InlineNote({
  taskId,
  note,
}: {
  taskId: string;
  note: string | null;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(note ?? '');
  const [flash, setFlash] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // What the server currently has — the Escape/rollback target.
  const savedRef = useRef(note ?? '');
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flashRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (flashRef.current) clearTimeout(flashRef.current);
    },
    [],
  );

  const save = (next: string) => {
    const trimmed = next.trim();
    if (trimmed === savedRef.current.trim()) return;
    void updateTaskMeta(taskId, {
      notes: trimmed === '' ? null : trimmed,
    }).then((result) => {
      if (result.ok) {
        savedRef.current = trimmed;
        setError(null);
        setFlash(true);
        if (flashRef.current) clearTimeout(flashRef.current);
        flashRef.current = setTimeout(() => setFlash(false), FLASH_MS);
      } else {
        setError(result.message);
      }
    });
  };

  const onChange = (next: string) => {
    setValue(next);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => save(next), DEBOUNCE_MS);
  };

  const onBlur = () => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    save(value);
    setEditing(false);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      if (debounceRef.current) clearTimeout(debounceRef.current);
      setValue(savedRef.current);
      setEditing(false);
    }
  };

  if (editing) {
    return (
      <span className="note-wrap">
        <textarea
          // biome-ignore lint/a11y/noAutofocus: the user just clicked this exact spot to type — focus continues their action in place
          autoFocus
          className="note-edit"
          rows={1}
          value={value}
          placeholder="Add note…"
          aria-label="Task note"
          onChange={(e) => onChange(e.target.value)}
          onBlur={onBlur}
          onKeyDown={onKeyDown}
        />
        {flash ? <span className="note-saved">Saved ✓</span> : null}
        {error ? <span className="status-err note-err">{error}</span> : null}
      </span>
    );
  }

  const firstLine = value.split('\n', 1)[0] ?? '';
  return (
    <span className="note-wrap">
      <button
        type="button"
        className={firstLine === '' ? 'note-btn note-ghost' : 'note-btn'}
        onClick={() => setEditing(true)}
        title={value !== '' ? value : 'Add a note'}
      >
        {firstLine === '' ? 'Add note…' : firstLine}
      </button>
      {flash ? <span className="note-saved">Saved ✓</span> : null}
      {error ? <span className="status-err note-err">{error}</span> : null}
    </span>
  );
}
