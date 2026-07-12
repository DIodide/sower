// Shared presentational pieces for the dark minimal dashboard aesthetic.
// Server-component friendly: no client APIs; <details> handles expand/collapse.
import type { CSSProperties, ReactNode } from 'react';
import { stateColor, truncate } from './format';

export const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';
export const MUTED = '#8b93a7';
export const BORDER = '#1c2130';
export const PANEL_BG = '#10141d';

export const cellStyle: CSSProperties = {
  padding: '0.5rem 0.75rem',
  borderBottom: `1px solid ${BORDER}`,
  textAlign: 'left',
  fontSize: '0.875rem',
  verticalAlign: 'top',
};

export const headStyle: CSSProperties = {
  ...cellStyle,
  color: MUTED,
  fontSize: '0.75rem',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  whiteSpace: 'nowrap',
};

export const monoCellStyle: CSSProperties = {
  ...cellStyle,
  fontFamily: MONO,
};

export const linkStyle: CSSProperties = {
  color: '#7aa2f7',
  textDecoration: 'none',
};

export function StateBadge({ state }: { state: string }) {
  const color = stateColor(state);
  return (
    <span
      style={{
        backgroundColor: color.bg,
        color: color.fg,
        borderRadius: '9999px',
        padding: '0.125rem 0.625rem',
        fontSize: '0.75rem',
        fontWeight: 600,
        fontFamily: MONO,
        whiteSpace: 'nowrap',
      }}
    >
      {state}
    </span>
  );
}

export function SectionHeading({ children }: { children: ReactNode }) {
  return (
    <h2
      style={{
        fontSize: '0.8125rem',
        fontWeight: 600,
        color: MUTED,
        textTransform: 'uppercase',
        letterSpacing: '0.08em',
        margin: '2rem 0 0.75rem',
        fontFamily: MONO,
      }}
    >
      {children}
    </h2>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <p style={{ color: MUTED, fontSize: '0.875rem', margin: '0.5rem 0' }}>
      {children}
    </p>
  );
}

export function TableWrap({ children }: { children: ReactNode }) {
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        {children}
      </table>
    </div>
  );
}

/**
 * Long-string display: shows a truncated preview; when the text is longer
 * than `max`, wraps it in a <details> so it can be expanded without JS.
 */
export function ExpandableText({
  text,
  max = 120,
}: {
  text: string;
  max?: number;
}) {
  if (text.length <= max) {
    return <span style={{ overflowWrap: 'anywhere' }}>{text}</span>;
  }
  return (
    <details>
      <summary style={{ cursor: 'pointer', color: 'inherit' }}>
        {truncate(text, max)}
      </summary>
      <pre
        style={{
          whiteSpace: 'pre-wrap',
          overflowWrap: 'anywhere',
          fontFamily: MONO,
          fontSize: '0.75rem',
          backgroundColor: PANEL_BG,
          border: `1px solid ${BORDER}`,
          borderRadius: '0.375rem',
          padding: '0.5rem 0.75rem',
          margin: '0.5rem 0 0',
          maxHeight: '20rem',
          overflowY: 'auto',
        }}
      >
        {text}
      </pre>
    </details>
  );
}
