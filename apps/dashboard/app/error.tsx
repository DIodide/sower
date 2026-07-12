'use client';

// Global error boundary: shown when a server component throws (e.g. missing
// DATABASE_URL or an unreachable database). Must be a client component.
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="card" style={{ maxWidth: '36rem' }}>
      <h2
        className="section-title"
        style={{ margin: '0 0 0.5rem', color: 'var(--danger-fg)' }}
      >
        Something went wrong
      </h2>
      <p
        className="hint"
        style={{ margin: '0 0 1rem', overflowWrap: 'anywhere' }}
      >
        {error.message || 'unexpected error'}
        {error.digest ? (
          <span className="mono"> (digest: {error.digest})</span>
        ) : null}
      </p>
      <button type="button" onClick={reset} className="btn btn--primary">
        Try again
      </button>
    </div>
  );
}
