// Task-detail-specific presentational pieces, layered on the shared lib/ui
// primitives. No 'use client' / 'use server' directive: pure presentation
// (native <details> for expand/collapse) so these render from server
// components AND compose inside the client form without pulling server-only
// code into the client bundle. All styling lives in app/globals.css.
import type { ReactNode } from 'react';
import type { Tone } from '../../../lib/format';

export function Badge({
  tone,
  title,
  children,
}: {
  tone: Tone | 'accent';
  title?: string;
  children: ReactNode;
}) {
  return (
    <span className={`badge badge--${tone}`} title={title}>
      {children}
    </span>
  );
}

function safeStringify(value: unknown): string {
  try {
    const json = JSON.stringify(value, null, 2);
    return json === undefined ? String(value) : json;
  } catch {
    return '[unserializable value]';
  }
}

/** Pretty-printed JSON behind a <details> expander (no client JS needed). */
export function JsonDetails({
  label,
  value,
}: {
  label: string;
  value: unknown;
}) {
  if (value === null || value === undefined) {
    return null;
  }
  return (
    <details className="expand" style={{ marginTop: '0.25rem' }}>
      <summary>{label}</summary>
      <pre className="codeblock">{safeStringify(value)}</pre>
    </details>
  );
}
