'use client';

export default function TaskError({
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
        Something went wrong loading this task
      </h2>
      <p className="hint" style={{ margin: '0 0 1rem' }}>
        {error.digest
          ? `error digest: ${error.digest}`
          : (error.message ?? 'unknown error')}
      </p>
      <button type="button" onClick={reset} className="btn btn--primary">
        Try again
      </button>
    </div>
  );
}
