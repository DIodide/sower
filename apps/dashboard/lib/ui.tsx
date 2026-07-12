// Shared presentational pieces for the clay dashboard aesthetic.
// Server-component friendly: no client APIs; <details> handles expand/collapse.
// All styling lives in app/globals.css.
import type { ReactNode } from 'react';
import { stateMeta, truncate } from './format';

/** Task-state pill: human label + semantic tone, raw enum in the tooltip. */
export function StateBadge({ state }: { state: string }) {
  const meta = stateMeta(state);
  return (
    <span className={`badge badge--${meta.tone}`} title={state}>
      {meta.label}
    </span>
  );
}

export function SectionHeading({
  children,
  count,
}: {
  children: ReactNode;
  count?: number;
}) {
  return (
    <h2 className="section-title">
      {children}
      {count !== undefined ? <span className="count">{count}</span> : null}
    </h2>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="hint">{children}</p>;
}

export function TableWrap({ children }: { children: ReactNode }) {
  return (
    <div className="table-card">
      <table>{children}</table>
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
    <details className="expand">
      <summary>{truncate(text, max)}</summary>
      <pre className="codeblock">{text}</pre>
    </details>
  );
}
