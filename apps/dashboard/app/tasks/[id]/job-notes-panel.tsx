'use client';

// The task page's job-notes scratchpad (the right column of the questions
// split): server-fetched notes as props, create/delete via server actions.
// Deliberately its OWN client island so it can never sit inside the
// NEEDS_INPUT answers <form> — its controls must not be swept into a
// saveAnswers submit. Mirrors FollowupAddForm's pattern (useActionState +
// router.refresh once the write lands).

import { useRouter } from 'next/navigation';
import { useActionState, useRef, useState, useTransition } from 'react';
import { ExpandableText } from '../../../lib/ui';
import type { JobNoteActionResult } from './actions';
import { createJobNote, deleteJobNote } from './actions';
import { Badge } from './ui';

export interface JobNoteView {
  id: string;
  body: string;
  /** Label of the tied question (raw id fallback); absent = general note. */
  questionLabel?: string;
  /** Relative created time, rendered server-side like the other panels. */
  createdLabel: string;
}

export interface NoteQuestionOption {
  id: string;
  label: string;
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
  const router = useRouter();
  const formRef = useRef<HTMLFormElement | null>(null);
  const [lastSync, setLastSync] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  const [result, formAction, pending] = useActionState<
    JobNoteActionResult | null,
    FormData
  >(async (_prev, formData) => {
    const body = formData.get('body');
    if (typeof body !== 'string' || body.trim() === '') {
      return { ok: false, message: 'write the note first.' };
    }
    const questionId = formData.get('questionId');
    const outcome = await createJobNote(taskId, {
      body: body.trim(),
      ...(typeof questionId === 'string' && questionId !== ''
        ? { questionId }
        : {}),
    });
    if (outcome.ok) {
      formRef.current?.reset();
      setLastSync(outcome.sync ?? null);
      router.refresh();
    }
    return outcome;
  }, null);

  const remove = (noteId: string) => {
    // Instant delete: no confirm — the row just dims while in flight.
    setDeletingId(noteId);
    setDeleteError(null);
    startTransition(async () => {
      const outcome = await deleteJobNote(taskId, noteId);
      setDeletingId(null);
      if (outcome.ok) {
        setLastSync(outcome.sync ?? null);
        router.refresh();
      } else {
        setDeleteError(outcome.message);
      }
    });
  };

  const hint = lastSync !== null ? syncHint(lastSync) : null;

  return (
    <aside className="card" aria-label="job notes">
      <h3
        className="section-title"
        style={{ margin: '0 0 0.5rem', fontSize: '0.95rem' }}
      >
        Job notes <span className="count">{notes.length}</span>
      </h3>
      {notes.length === 0 ? (
        <p className="hint faint" style={{ margin: '0 0 0.625rem' }}>
          Notes live in your portfolio repo (private/jobs/…/scratchpad.md) and
          stay with this application — jot down anything worth remembering,
          optionally tied to a question.
        </p>
      ) : (
        <div style={{ marginBottom: '0.625rem' }}>
          {notes.map((note) => {
            const deleting = deletingId === note.id;
            return (
              <div
                key={note.id}
                className="q-row"
                style={
                  deleting ? { opacity: 0.5, pointerEvents: 'none' } : undefined
                }
              >
                <div className="q-label-row">
                  {note.questionLabel !== undefined ? (
                    <Badge tone="neutral" title="tied to this question">
                      {note.questionLabel}
                    </Badge>
                  ) : null}
                  <span className="hint faint spread">{note.createdLabel}</span>
                  <button
                    type="button"
                    className="btn btn--sm"
                    onClick={() => remove(note.id)}
                    disabled={deleting}
                    aria-label="Delete note"
                    title="Delete this note (the scratchpad file is rewritten without it)"
                  >
                    ✕
                  </button>
                </div>
                <div style={{ whiteSpace: 'pre-wrap', fontSize: '0.875rem' }}>
                  <ExpandableText text={note.body} max={280} />
                </div>
              </div>
            );
          })}
        </div>
      )}
      <form ref={formRef} action={formAction}>
        <div style={{ display: 'grid', gap: '0.5rem' }}>
          <textarea
            name="body"
            className="field"
            rows={3}
            placeholder="a note about this job…"
            aria-label="New note"
            maxLength={20_000}
            required
            disabled={pending}
          />
          <select
            name="questionId"
            className="field"
            defaultValue=""
            aria-label="Tie the note to a question (optional)"
            disabled={pending}
          >
            <option value="">— general note —</option>
            {questions.map((q) => (
              <option key={q.id} value={q.id}>
                {q.label}
              </option>
            ))}
          </select>
          <div className="row">
            <button
              type="submit"
              className="btn btn--primary"
              disabled={pending}
              title="Save the note and rewrite the scratchpad file in your portfolio repo"
            >
              {pending ? 'Adding…' : 'Add note'}
            </button>
          </div>
        </div>
      </form>
      {result && !result.ok ? (
        <p
          role="status"
          className="status-err"
          style={{ margin: '0.5rem 0 0', wordBreak: 'break-word' }}
        >
          {result.message}
        </p>
      ) : null}
      {deleteError !== null ? (
        <p
          role="status"
          className="status-err"
          style={{ margin: '0.5rem 0 0', wordBreak: 'break-word' }}
        >
          {deleteError}
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
