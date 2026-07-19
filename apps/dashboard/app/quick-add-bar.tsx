'use client';

// The Applications workspace's front door: paste anything (links, a job
// description, a whole email) and the ingest classifier sorts it out. A
// single line that grows into a textarea on focus; Enter submits, Shift+Enter
// makes a newline. A small "add manually" link opens a 3-field mini-form for
// URL-less jobs (recruiter conversations, career-fair leads).

import { useState, useTransition } from 'react';
import { manualAdd, pasteIngest } from './quick-add/actions';
import type { ActionResult } from './tasks/[id]/actions';

export function QuickAddBar() {
  const [text, setText] = useState('');
  const [focused, setFocused] = useState(false);
  const [result, setResult] = useState<ActionResult | null>(null);
  const [pending, startTransition] = useTransition();

  const [showManual, setShowManual] = useState(false);
  const [company, setCompany] = useState('');
  const [title, setTitle] = useState('');
  const [note, setNote] = useState('');
  const [manualResult, setManualResult] = useState<ActionResult | null>(null);
  const [manualPending, startManual] = useTransition();

  // No router.refresh() after either action: they revalidatePath('/'), which
  // already refreshes this route on the same server-action round trip.
  const submitPaste = () => {
    if (text.trim() === '' || pending) return;
    startTransition(async () => {
      const r = await pasteIngest(text);
      setResult(r);
      if (r.ok) setText('');
    });
  };

  const submitManual = () => {
    if (company.trim() === '' || manualPending) return;
    startManual(async () => {
      const r = await manualAdd({
        company: company.trim(),
        ...(title.trim() !== '' ? { title: title.trim() } : {}),
        ...(note.trim() !== '' ? { notes: note.trim() } : {}),
      });
      setManualResult(r);
      if (r.ok) {
        setCompany('');
        setTitle('');
        setNote('');
      }
    });
  };

  const expanded = focused || text.includes('\n') || text.length > 90;

  return (
    <div className="quick-add card--tight card">
      <div className="quick-add-row">
        <textarea
          className="quick-add-input"
          rows={expanded ? 3 : 1}
          value={text}
          placeholder="Paste a job link, a description, or anything — sower will figure it out"
          aria-label="Add jobs — paste links or text"
          onChange={(e) => setText(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onKeyDown={(e) => {
            // isComposing: Enter inside an IME composition picks a candidate,
            // it must never submit.
            if (
              e.key === 'Enter' &&
              !e.shiftKey &&
              !e.nativeEvent.isComposing
            ) {
              e.preventDefault();
              submitPaste();
            }
          }}
        />
        <button
          type="button"
          className="btn btn--primary"
          disabled={pending || text.trim() === ''}
          onClick={submitPaste}
        >
          {pending ? 'Adding…' : 'Add'}
        </button>
      </div>
      <div className="quick-add-foot">
        {result ? (
          <span
            role="status"
            className={result.ok ? 'status-ok' : 'status-err'}
          >
            {result.message}
          </span>
        ) : null}
        <button
          type="button"
          className="quick-add-manual-link"
          onClick={() => setShowManual((v) => !v)}
        >
          {showManual ? 'hide manual add' : 'add manually'}
        </button>
      </div>
      {showManual ? (
        <div className="quick-add-manual">
          <input
            className="field"
            value={company}
            placeholder="Company (required)"
            aria-label="Company"
            maxLength={200}
            onChange={(e) => setCompany(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                submitManual();
              }
            }}
          />
          <input
            className="field"
            value={title}
            placeholder="Role title"
            aria-label="Role title"
            maxLength={300}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                submitManual();
              }
            }}
          />
          <input
            className="field"
            value={note}
            placeholder="Note (met at career fair, …)"
            aria-label="Note"
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                submitManual();
              }
            }}
          />
          <button
            type="button"
            className="btn btn--sm"
            disabled={manualPending || company.trim() === ''}
            onClick={submitManual}
          >
            {manualPending ? 'Adding…' : 'Add job'}
          </button>
          {manualResult ? (
            <span
              role="status"
              className={manualResult.ok ? 'status-ok' : 'status-err'}
              style={{ flexBasis: '100%' }}
            >
              {manualResult.message}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
