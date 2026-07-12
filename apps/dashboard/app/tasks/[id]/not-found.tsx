import Link from 'next/link';

export default function TaskNotFound() {
  return (
    <div
      style={{
        backgroundColor: '#0f1420',
        border: '1px solid #1c2130',
        borderRadius: '0.5rem',
        padding: '1.25rem',
      }}
    >
      <h2 style={{ margin: '0 0 0.5rem 0', fontSize: '1rem' }}>
        task not found
      </h2>
      <p
        style={{ margin: '0 0 1rem 0', fontSize: '0.875rem', color: '#8b93a7' }}
      >
        no application task exists with that id.
      </p>
      <Link
        href="/"
        style={{
          color: '#93c5fd',
          textDecoration: 'none',
          fontSize: '0.875rem',
        }}
      >
        ← back to tasks
      </Link>
    </div>
  );
}
