'use client';

import { useState } from 'react';
import type { DocumentOption } from './questions-panel';

/**
 * The stored-document choice for a file question, with the chosen file
 * shown right there: a resume is the one answer worth looking at before
 * it goes out, and the library holds several (a master, tailored copies,
 * old uploads). PDFs render inline through the dashboard's own document
 * route (IAP-gated, streams from the vault); anything else gets a link.
 */
export function DocumentPicker({
  inputId,
  name,
  options,
  defaultDocId,
  kindLabel,
}: {
  inputId: string;
  name: string;
  options: DocumentOption[];
  defaultDocId: string;
  kindLabel: string;
}) {
  const [docId, setDocId] = useState(defaultDocId);
  const chosen = options.find((d) => d.id === docId);
  const isPdf = chosen !== undefined && /\.pdf$/i.test(chosen.filename);
  return (
    <div style={{ display: 'grid', gap: '0.4rem' }}>
      <label htmlFor={inputId} className="field-label">
        Use a stored {kindLabel}
      </label>
      <select
        id={inputId}
        name={name}
        value={docId}
        onChange={(event) => setDocId(event.target.value)}
        className="field"
      >
        <option value="">— none —</option>
        {options.map((d) => (
          <option key={d.id} value={d.id}>
            {d.filename} ({d.createdLabel})
          </option>
        ))}
      </select>
      {chosen ? (
        isPdf ? (
          <iframe
            title={`Preview of ${chosen.filename}`}
            src={`/documents/${chosen.id}`}
            style={{
              width: '100%',
              height: '32rem',
              border: '1px solid var(--line)',
              borderRadius: '6px',
              background: 'white',
            }}
          />
        ) : (
          <a
            href={`/documents/${chosen.id}`}
            target="_blank"
            rel="noreferrer"
            className="hint"
          >
            Open {chosen.filename}
          </a>
        )
      ) : null}
    </div>
  );
}
