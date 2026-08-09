'use client';

// The task page's job-notes scratchpad (the right column of the questions
// split): a client-side-first stack of always-editable notes — no submit
// anywhere. Server data only SEEDS the state; after hydration the panel owns
// it (single-user app, no cross-client reconciliation): every mutation lands
// instantly and persists in the background on inline-note's idiom (800ms
// debounce, unmount flush, dirty '…', escape revert), a failed persist shows
// the quiet inline error and KEEPS the text, and no note op ever refreshes
// the router (nothing else on the page depends on notes). The top slot is a
// permanent empty composer: typing in it optimistically creates the note
// (client key first, real id reconciled when the create returns — follow-up
// edits made while the create is in flight are parked and replayed against
// the real id) and a fresh composer appears above. Deliberately its OWN
// client island so it can never sit inside the NEEDS_INPUT answers <form>.

import { useEffect, useRef, useState } from 'react';
import { autogrow } from '../../../lib/inline-note';
import type { JobNoteActionResult } from './actions';
import { createJobNote, deleteJobNote, updateJobNote } from './actions';

const DEBOUNCE_MS = 800;
const FLASH_MS = 1_500;
/** Mirrors the api's notes cap — checked here so the error is instant. */
const NOTE_MAX_CHARS = 20_000;

export interface JobNoteView {
  id: string;
  body: string;
  /** jobSpec question id this note is tied to; absent = general note. */
  questionId?: string;
  /** Relative created time, rendered server-side like the other panels. */
  createdLabel: string;
}

export interface NoteQuestionOption {
  id: string;
  label: string;
}

/** One slot in the stack. `key` is the stable CLIENT identity (a fresh note
 *  keeps it across id reconciliation, so React never remounts the textarea
 *  under the user's cursor); `id` is the server row, null until the create
 *  returns. body/questionId are only the SEED — the row owns live text. */
interface NoteEntry {
  key: string;
  id: string | null;
  body: string;
  /** '' = general note. */
  questionId: string;
  createdLabel?: string;
}

/** Per-slot persistence bookkeeping, in a ref: these outlive renders and are
 *  consulted by async completions (create reconciliation, unmount flushes). */
interface RowMeta {
  id: string | null;
  creating: boolean;
  /** Edits parked while the create is in flight — replayed as one update
   *  against the real id the moment it arrives. */
  pending: {
    patch: { body: string; questionId: string };
    resolve: (result: JobNoteActionResult) => void;
  } | null;
  deleted: boolean;
}

/** The quiet line for a non-'mirrored' sync outcome — the note itself is
 *  always saved (DB first), so neither case is an error banner. */
function syncHint(sync: string): string | null {
  if (sync === 'mirrored') return null;
  if (sync === 'skipped: no token') {
    return 'GitHub mirror is off (no token) — notes are saved in sower only.';
  }
  return 'GitHub mirror failed — will retry on next change.';
}

export function JobNotesPanel({
  taskId,
  notes,
  questions,
}: {
  taskId: string;
  notes: JobNoteView[];
  /** The task's questions, for tying a note to one ('' = general). */
  questions: NoteQuestionOption[];
}) {
  // entries[0] is ALWAYS the composer slot; below it, notes newest-first
  // (server rows arrive oldest-first, the scratchpad's order) so a fresh
  // note stays right where it was typed — just under the composer.
  const [entries, setEntries] = useState<NoteEntry[]>(() => [
    { key: 'slot-0', id: null, body: '', questionId: '' },
    ...[...notes].reverse().map((n) => ({
      key: `n-${n.id}`,
      id: n.id,
      body: n.body,
      questionId: n.questionId ?? '',
      createdLabel: n.createdLabel,
    })),
  ]);
  const [lastSync, setLastSync] = useState<string | null>(null);
  // Delete failures land here (the row is briefly gone, so it can't show
  // its own inline error); the row is restored alongside.
  const [panelError, setPanelError] = useState<string | null>(null);

  const keyRef = useRef(0);
  const metaRef = useRef(new Map<string, RowMeta>());
  // Live text per slot, mirrored up by rows on every change — a delete that
  // fails restores the LATEST text, never the seed ("nothing is ever lost").
  const textRef = useRef(
    new Map<string, { body: string; questionId: string }>(),
  );

  const getMeta = (key: string, id: string | null): RowMeta => {
    const existing = metaRef.current.get(key);
    if (existing) return existing;
    const created: RowMeta = {
      id,
      creating: false,
      pending: null,
      deleted: false,
    };
    metaRef.current.set(key, created);
    return created;
  };

  /** First keystroke in the composer: the slot becomes a real (optimistic)
   *  note in place — keeping its key, so the focused textarea never moves —
   *  and a fresh empty composer appears above it. */
  const promote = (key: string) => {
    keyRef.current += 1;
    const slotKey = `slot-${keyRef.current}`;
    setEntries((prev) =>
      prev[0]?.key === key
        ? [{ key: slotKey, id: null, body: '', questionId: '' }, ...prev]
        : prev,
    );
  };

  /** Persist one slot's current text+tie: update when the real id is known,
   *  create on the first save, and PARK the patch while a create is in
   *  flight (never a second create — the queued patch replays as an update
   *  once the id arrives). */
  const persistRow = async (
    entry: NoteEntry,
    body: string,
    questionId: string,
  ): Promise<JobNoteActionResult> => {
    const meta = getMeta(entry.key, entry.id);
    // Deleted while a save was queued (the unmount flush): quietly drop it.
    if (meta.deleted) return { ok: true, message: 'deleted.' };
    if (meta.id !== null) {
      const outcome = await updateJobNote(taskId, meta.id, {
        body,
        questionId: questionId === '' ? null : questionId,
      });
      if (outcome.ok) setLastSync(outcome.sync ?? null);
      return outcome;
    }
    if (meta.creating) {
      return new Promise<JobNoteActionResult>((resolve) => {
        // Only the newest parked patch matters; the displaced one was
        // absorbed by it (its resolver must still settle, though).
        meta.pending?.resolve({ ok: true, message: 'superseded.' });
        meta.pending = { patch: { body, questionId }, resolve };
      });
    }
    meta.creating = true;
    let outcome: JobNoteActionResult;
    try {
      outcome = await createJobNote(taskId, {
        body,
        ...(questionId !== '' ? { questionId } : {}),
      });
    } catch {
      outcome = {
        ok: false,
        message: 'not saved — could not reach the server; your text is safe.',
      };
    }
    meta.creating = false;
    if (outcome.ok) {
      const realId = outcome.noteId;
      if (realId === undefined) {
        // ok without an id would strand the optimistic note (retrying would
        // duplicate it) — surface it as a failure; the text stays put.
        outcome = {
          ok: false,
          message: 'save failed: unexpected api response.',
        };
      } else {
        meta.id = realId;
        setLastSync(outcome.sync ?? null);
        setEntries((prev) =>
          prev.map((e) => (e.key === entry.key ? { ...e, id: realId } : e)),
        );
        if (meta.deleted) {
          // '×' hit while the create was in flight — finish the delete now.
          void deleteJobNote(taskId, realId).catch(() => {});
        }
      }
    }
    // On failure meta.id stays null, so the row's next save retries the
    // create with the (kept) text.
    const pending = meta.pending;
    meta.pending = null;
    if (pending) {
      if (meta.id !== null && !meta.deleted) {
        void persistRow(
          entry,
          pending.patch.body,
          pending.patch.questionId,
        ).then(pending.resolve);
      } else {
        pending.resolve(outcome);
      }
    }
    return outcome;
  };

  /** Optimistic delete: the row vanishes instantly; a failed server delete
   *  restores it (with its latest text) plus a quiet error. */
  const removeRow = (entry: NoteEntry) => {
    const meta = getMeta(entry.key, entry.id);
    meta.deleted = true;
    setPanelError(null);
    setEntries((prev) => prev.filter((e) => e.key !== entry.key));
    const id = meta.id;
    // Never persisted yet: nothing to delete server-side (an in-flight
    // create finishes the delete itself via meta.deleted).
    if (id === null) return;
    void deleteJobNote(taskId, id)
      .then((outcome) => {
        if (outcome.ok) setLastSync(outcome.sync ?? null);
        else restoreRow(entry, outcome.message);
      })
      .catch(() =>
        restoreRow(entry, 'delete failed — could not reach the server.'),
      );
  };

  const restoreRow = (entry: NoteEntry, message: string) => {
    const meta = metaRef.current.get(entry.key);
    if (meta) meta.deleted = false;
    const latest = textRef.current.get(entry.key);
    setEntries((prev) => {
      if (prev.some((e) => e.key === entry.key)) return prev;
      const restored: NoteEntry = {
        ...entry,
        id: meta?.id ?? entry.id,
        body: latest?.body ?? entry.body,
        questionId: latest?.questionId ?? entry.questionId,
      };
      // Back just under the composer — its exact old slot may be gone.
      const [composerEntry, ...rest] = prev;
      return composerEntry
        ? [composerEntry, restored, ...rest]
        : [restored, ...rest];
    });
    setPanelError(message);
  };

  const noteCount = entries.length - 1;
  const hint = lastSync !== null ? syncHint(lastSync) : null;

  return (
    <aside className="card" aria-label="job notes">
      <h3
        className="section-title"
        style={{ margin: '0 0 0.5rem', fontSize: '0.95rem' }}
      >
        Job notes <span className="count">{noteCount}</span>
      </h3>
      {noteCount === 0 ? (
        <p className="hint faint" style={{ margin: '0 0 0.25rem' }}>
          Notes live in your portfolio repo (private/jobs/…/scratchpad.md) and
          stay with this application — jot down anything worth remembering,
          optionally tied to a question.
        </p>
      ) : null}
      <div>
        {entries.map((entry, index) => (
          <NoteRow
            key={entry.key}
            entry={entry}
            composer={index === 0}
            questions={questions}
            onPromote={() => promote(entry.key)}
            persist={(body, questionId) => persistRow(entry, body, questionId)}
            onRemove={() => removeRow(entry)}
            onTextChange={(body, questionId) => {
              textRef.current.set(entry.key, { body, questionId });
            }}
          />
        ))}
      </div>
      {panelError !== null ? (
        <p
          role="status"
          className="status-err"
          style={{ margin: '0.5rem 0 0', wordBreak: 'break-word' }}
        >
          {panelError}
        </p>
      ) : null}
      {hint !== null ? (
        <p className="hint faint" style={{ margin: '0.5rem 0 0' }}>
          {hint}
        </p>
      ) : null}
    </aside>
  );
}

/** One always-editable slot: inline-note's autosave idiom (800ms debounce,
 *  blur save, unmount flush, dirty '…', escape revert) on a borderless
 *  autogrowing textarea, plus the quiet question-tie select. */
function NoteRow({
  entry,
  composer,
  questions,
  onPromote,
  persist,
  onRemove,
  onTextChange,
}: {
  entry: NoteEntry;
  /** The permanent empty top slot (ghost placeholder, no delete). */
  composer: boolean;
  questions: NoteQuestionOption[];
  onPromote: () => void;
  persist: (body: string, questionId: string) => Promise<JobNoteActionResult>;
  onRemove: () => void;
  /** Mirrors live text up to the panel (for delete-restore). */
  onTextChange: (body: string, questionId: string) => void;
}) {
  const [value, setValue] = useState(entry.body);
  // What the server currently has, as state so the dirty "…" can render.
  const [savedValue, setSavedValue] = useState(entry.body);
  const [tie, setTie] = useState(entry.questionId);
  const [flash, setFlash] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Refs mirroring the above for closures that outlive a render (debounce
  // timers, the unmount flush).
  const valueRef = useRef(entry.body);
  const savedRef = useRef(entry.body);
  const tieRef = useRef(entry.questionId);
  const savedTieRef = useRef(entry.questionId);
  // Escape target: the value when THIS edit session (focus) began.
  const sessionStartRef = useRef(entry.body);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flashRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Latest persist target in a ref so the unmount flush (deps: []) always
  // calls the current closure — the inline-note pattern.
  const persistRef = useRef(persist);
  persistRef.current = persist;

  useEffect(
    () => () => {
      if (flashRef.current) clearTimeout(flashRef.current);
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
        // FLUSH the pending save — unmounting must never lose typed text.
        // (A row unmounted by its own delete is dropped by the panel's
        // meta.deleted guard, not here.)
        const trimmed = valueRef.current.trim();
        if (
          trimmed !== '' &&
          trimmed.length <= NOTE_MAX_CHARS &&
          (trimmed !== savedRef.current.trim() ||
            tieRef.current !== savedTieRef.current)
        ) {
          void persistRef.current(trimmed, tieRef.current).catch(() => {});
        }
      }
    },
    [],
  );

  const save = (next: string, nextTie: string) => {
    const trimmed = next.trim();
    // Client-side length check: the real message, before any network call.
    if (trimmed.length > NOTE_MAX_CHARS) {
      setError('note is too long (max 20,000 characters)');
      return;
    }
    // A note can never be blank: emptied text just stays dirty client-side
    // ('×' is the delete) and the composer only creates once something is
    // typed.
    if (trimmed === '') return;
    if (
      trimmed === savedRef.current.trim() &&
      nextTie === savedTieRef.current
    ) {
      return;
    }
    persistRef
      .current(trimmed, nextTie)
      .then((result) => {
        if (result.ok) {
          savedRef.current = trimmed;
          savedTieRef.current = nextTie;
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
    // First keystroke in the composer: become a note, spawn a fresh
    // composer above (this row keeps its key, so focus stays put).
    if (composer && valueRef.current === '' && next !== '') onPromote();
    setValue(next);
    valueRef.current = next;
    onTextChange(next, tieRef.current);
    autogrow(event.target);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      debounceRef.current = null;
      save(valueRef.current, tieRef.current);
    }, DEBOUNCE_MS);
  };

  const onTie = (event: React.ChangeEvent<HTMLSelectElement>) => {
    const next = event.target.value;
    setTie(next);
    tieRef.current = next;
    onTextChange(valueRef.current, next);
    // A select is one discrete change — save immediately (no debounce),
    // unless nothing has been written yet (the composer pre-creation just
    // remembers the pick for the create).
    if (valueRef.current.trim() !== '') save(valueRef.current, next);
  };

  const onFocus = () => {
    sessionStartRef.current = valueRef.current;
  };

  const onBlur = () => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    save(valueRef.current, tieRef.current);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    const snapshot = sessionStartRef.current;
    if (snapshot.trim() === '') {
      // The session started blank, so there is nothing to revert TO: the
      // composer just clears; a note typed entirely this session is removed
      // (rolling back any debounce checkpoint that already created it).
      if (composer) {
        setValue('');
        valueRef.current = '';
        onTextChange('', tieRef.current);
      } else {
        onRemove();
      }
      return;
    }
    setValue(snapshot);
    valueRef.current = snapshot;
    onTextChange(snapshot, tieRef.current);
    // A mid-session debounce may already have written; roll the server
    // back to the session-start value too (no-op if nothing was written).
    save(snapshot, tieRef.current);
  };

  // A tie pointing at a question the current spec no longer has (e.g. after
  // a re-ingest) still needs an option to display — raw id, like the mirror.
  const tieOptions =
    tie === '' || questions.some((q) => q.id === tie)
      ? questions
      : [...questions, { id: tie, label: tie }];

  const dirty = value.trim() !== savedValue.trim();

  return (
    <div className="jn-row">
      <textarea
        ref={(el) => {
          if (el) autogrow(el);
        }}
        className="note-edit"
        rows={1}
        value={value}
        placeholder={composer ? 'Jot a note…' : undefined}
        aria-label={composer ? 'New note' : 'Note'}
        onChange={onChange}
        onFocus={onFocus}
        onBlur={onBlur}
        onKeyDown={onKeyDown}
        // A drag on the native resize corner pins the user's chosen size:
        // height changed between pointerdown/up (typing can't do that while
        // the pointer is held) → mark manual, and autogrow steps aside.
        onPointerDown={(event) => {
          event.currentTarget.dataset.dragStartHeight = String(
            event.currentTarget.offsetHeight,
          );
        }}
        onPointerUp={(event) => {
          const el = event.currentTarget;
          const started = Number(el.dataset.dragStartHeight ?? '0');
          if (started > 0 && el.offsetHeight !== started) {
            el.dataset.manualSize = '1';
            el.style.maxHeight = 'none';
          }
        }}
      />
      <div className="jn-meta">
        <select
          className="jn-tie"
          value={tie}
          aria-label="Tie the note to a question (optional)"
          onChange={onTie}
        >
          <option value="">— general —</option>
          {tieOptions.map((q) => (
            <option key={q.id} value={q.id}>
              {q.label}
            </option>
          ))}
        </select>
        {entry.createdLabel !== undefined ? (
          <span className="hint faint">{entry.createdLabel}</span>
        ) : null}
        <span className="jn-right">
          {dirty && error === null ? (
            <span className="note-dirty" title="not saved yet">
              …
            </span>
          ) : null}
          {flash && !dirty ? <span className="note-saved">Saved ✓</span> : null}
          {!composer ? (
            <button
              type="button"
              className="jn-del"
              onClick={onRemove}
              aria-label="Delete note"
              title="Delete this note (the scratchpad file is rewritten without it)"
            >
              ×
            </button>
          ) : null}
        </span>
        {error !== null ? (
          <span className="status-err note-err">{error}</span>
        ) : null}
      </div>
    </div>
  );
}
