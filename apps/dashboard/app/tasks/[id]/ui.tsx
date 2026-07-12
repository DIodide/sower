// Task-detail-specific presentational pieces, layered on the shared lib/ui
// primitives. No 'use client' / 'use server' directive: pure presentation
// (native <details> for expand/collapse) so these render from server
// components AND compose inside the client form without pulling server-only
// code into the client bundle.
import type { CSSProperties, ReactNode } from 'react';
import { BORDER, MONO } from '../../../lib/ui';

export const FAINT = '#5c6478';
export const INPUT_BG = '#0b0e14';
export const INPUT_BORDER = '#2a3145';

export function Badge({
  bg,
  fg,
  title,
  children,
}: {
  bg: string;
  fg: string;
  title?: string;
  children: ReactNode;
}) {
  return (
    <span
      title={title}
      style={{
        backgroundColor: bg,
        color: fg,
        borderRadius: '9999px',
        padding: '0.125rem 0.625rem',
        fontSize: '0.7rem',
        fontWeight: 600,
        fontFamily: MONO,
        whiteSpace: 'nowrap',
        display: 'inline-block',
      }}
    >
      {children}
    </span>
  );
}

export const preStyle: CSSProperties = {
  margin: '0.5rem 0 0 0',
  padding: '0.75rem',
  backgroundColor: '#0b0e14',
  border: `1px solid ${BORDER}`,
  borderRadius: '0.375rem',
  fontSize: '0.75rem',
  fontFamily: MONO,
  overflowX: 'auto',
  maxHeight: '24rem',
  overflowY: 'auto',
  whiteSpace: 'pre-wrap',
  overflowWrap: 'anywhere',
};

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
    <details style={{ marginTop: '0.25rem' }}>
      <summary
        style={{
          cursor: 'pointer',
          color: '#8b93a7',
          fontSize: '0.75rem',
          fontFamily: MONO,
          userSelect: 'none',
        }}
      >
        {label}
      </summary>
      <pre style={preStyle}>{safeStringify(value)}</pre>
    </details>
  );
}
