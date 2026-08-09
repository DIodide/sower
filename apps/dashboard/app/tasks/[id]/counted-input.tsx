'use client';

// Text/textarea question inputs with a LIVE character + word count under
// the box. Client-side state exists only for the counts — the control stays
// an uncontrolled form field (defaultValue + name) so the surrounding
// saveAnswers server-action form reads it exactly like a plain input.

import { useState } from 'react';

const MAX_CHARS = 20_000;

function countWords(text: string): number {
  const matches = text.match(/\S+/g);
  return matches ? matches.length : 0;
}

function Counts({ text }: { text: string }) {
  const words = countWords(text);
  const over = text.length >= MAX_CHARS;
  return (
    <span
      className={over ? 'status-err mono' : 'hint faint mono'}
      style={{ fontSize: '0.6875rem' }}
      aria-live="off"
    >
      {text.length.toLocaleString()} chars · {words.toLocaleString()}{' '}
      {words === 1 ? 'word' : 'words'}
      {over ? ' — limit reached' : ''}
    </span>
  );
}

export function CountedTextarea({
  inputId,
  name,
  defaultValue,
  required,
}: {
  inputId: string;
  name: string;
  defaultValue?: string;
  required: boolean;
}) {
  const [text, setText] = useState(defaultValue ?? '');
  return (
    <div style={{ display: 'grid', gap: '0.2rem', maxWidth: '34rem' }}>
      <textarea
        id={inputId}
        name={name}
        rows={4}
        maxLength={MAX_CHARS}
        defaultValue={defaultValue}
        aria-required={required}
        className="field"
        onChange={(event) => setText(event.target.value)}
      />
      <Counts text={text} />
    </div>
  );
}

export function CountedTextInput({
  inputId,
  name,
  defaultValue,
  required,
}: {
  inputId: string;
  name: string;
  defaultValue?: string;
  required: boolean;
}) {
  const [text, setText] = useState(defaultValue ?? '');
  return (
    <div style={{ display: 'grid', gap: '0.2rem', maxWidth: '34rem' }}>
      <input
        id={inputId}
        name={name}
        type="text"
        maxLength={MAX_CHARS}
        defaultValue={defaultValue}
        aria-required={required}
        className="field"
        onChange={(event) => setText(event.target.value)}
      />
      <Counts text={text} />
    </div>
  );
}
