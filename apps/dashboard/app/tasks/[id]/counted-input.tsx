'use client';

// Text/textarea question inputs with a LIVE character + word count under
// the box. Client-side state exists only for the counts — the control stays
// an uncontrolled form field (defaultValue + name) so the surrounding
// saveAnswers server-action form reads it exactly like a plain input.

import { useState } from 'react';

const MAX_CHARS = 20_000;

/** Source-declared answer cap (never fabricated — display + soft validation). */
export interface AnswerLimitView {
  kind: 'characters' | 'words';
  max: number;
}

function countWords(text: string): number {
  const matches = text.match(/\S+/g);
  return matches ? matches.length : 0;
}

function Counts({ text, limit }: { text: string; limit?: AnswerLimitView }) {
  const words = countWords(text);
  // A character limit is also enforced by the input's real maxLength; a word
  // limit only turns the count red (soft — the ATS may count differently).
  const over =
    limit?.kind === 'characters'
      ? text.length >= Math.min(MAX_CHARS, limit.max)
      : limit?.kind === 'words'
        ? words > limit.max
        : text.length >= MAX_CHARS;
  const charPart =
    limit?.kind === 'characters'
      ? `${text.length.toLocaleString()} / ${limit.max.toLocaleString()} chars`
      : `${text.length.toLocaleString()} chars`;
  const wordPart =
    limit?.kind === 'words'
      ? `${words.toLocaleString()} / ${limit.max.toLocaleString()} words`
      : `${words.toLocaleString()} ${words === 1 ? 'word' : 'words'}`;
  return (
    <span
      className={over ? 'status-err mono' : 'hint faint mono'}
      style={{ fontSize: '0.6875rem' }}
      aria-live="off"
    >
      {charPart} · {wordPart}
      {over ? ' — limit reached' : ''}
    </span>
  );
}

/** The real maxLength for the control: the hard cap, tightened by a
 *  source-declared character limit (word limits never block typing). */
function maxLengthFor(limit?: AnswerLimitView): number {
  return limit?.kind === 'characters'
    ? Math.min(MAX_CHARS, limit.max)
    : MAX_CHARS;
}

export function CountedTextarea({
  inputId,
  name,
  defaultValue,
  required,
  limit,
}: {
  inputId: string;
  name: string;
  defaultValue?: string;
  required: boolean;
  limit?: AnswerLimitView;
}) {
  const [text, setText] = useState(defaultValue ?? '');
  return (
    <div style={{ display: 'grid', gap: '0.2rem', maxWidth: '34rem' }}>
      <textarea
        id={inputId}
        name={name}
        rows={4}
        maxLength={maxLengthFor(limit)}
        defaultValue={defaultValue}
        aria-required={required}
        className="field"
        onChange={(event) => setText(event.target.value)}
      />
      <Counts text={text} limit={limit} />
    </div>
  );
}

export function CountedTextInput({
  inputId,
  name,
  defaultValue,
  required,
  limit,
}: {
  inputId: string;
  name: string;
  defaultValue?: string;
  required: boolean;
  limit?: AnswerLimitView;
}) {
  const [text, setText] = useState(defaultValue ?? '');
  return (
    <div style={{ display: 'grid', gap: '0.2rem', maxWidth: '34rem' }}>
      <input
        id={inputId}
        name={name}
        type="text"
        maxLength={maxLengthFor(limit)}
        defaultValue={defaultValue}
        aria-required={required}
        className="field"
        onChange={(event) => setText(event.target.value)}
      />
      <Counts text={text} limit={limit} />
    </div>
  );
}
