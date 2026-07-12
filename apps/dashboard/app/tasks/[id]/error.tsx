'use client';

export default function TaskError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div
      style={{
        backgroundColor: '#0f1420',
        border: '1px solid #3a1a1a',
        borderRadius: '0.5rem',
        padding: '1.25rem',
      }}
    >
      <h2
        style={{ margin: '0 0 0.5rem 0', fontSize: '1rem', color: '#f87171' }}
      >
        something went wrong loading this task
      </h2>
      <p
        style={{ margin: '0 0 1rem 0', fontSize: '0.875rem', color: '#8b93a7' }}
      >
        {error.digest
          ? `error digest: ${error.digest}`
          : (error.message ?? 'unknown error')}
      </p>
      <button
        type="button"
        onClick={reset}
        style={{
          backgroundColor: '#16283f',
          color: '#93c5fd',
          border: '1px solid #2a3145',
          borderRadius: '0.375rem',
          padding: '0.375rem 0.875rem',
          fontSize: '0.8rem',
          fontWeight: 600,
          cursor: 'pointer',
        }}
      >
        Try again
      </button>
    </div>
  );
}
