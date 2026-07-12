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
    <div style={{ padding: '2rem 0' }}>
      <h2
        style={{
          fontSize: '1rem',
          fontWeight: 600,
          color: '#f87171',
          margin: '0 0 0.5rem',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        }}
      >
        something went wrong
      </h2>
      <p
        style={{
          color: '#8b93a7',
          fontSize: '0.875rem',
          margin: '0 0 1rem',
          overflowWrap: 'anywhere',
        }}
      >
        {error.message || 'unexpected error'}
        {error.digest ? (
          <span
            style={{
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            }}
          >
            {' '}
            (digest: {error.digest})
          </span>
        ) : null}
      </p>
      <button
        type="button"
        onClick={reset}
        style={{
          backgroundColor: '#1c2130',
          color: '#d7dae0',
          border: '1px solid #2a3147',
          borderRadius: '0.375rem',
          padding: '0.375rem 0.875rem',
          fontSize: '0.8125rem',
          cursor: 'pointer',
          fontFamily: 'inherit',
        }}
      >
        try again
      </button>
    </div>
  );
}
