import Link from 'next/link';

export default function NotFound() {
  return (
    <div style={{ padding: '2rem 0' }}>
      <h2
        style={{
          fontSize: '1rem',
          fontWeight: 600,
          margin: '0 0 0.5rem',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        }}
      >
        404 — not found
      </h2>
      <p style={{ color: '#8b93a7', fontSize: '0.875rem', margin: '0 0 1rem' }}>
        this task, platform, or tenant does not exist (or has no data yet).
      </p>
      <p style={{ fontSize: '0.875rem', margin: 0 }}>
        <Link href="/" style={{ color: '#7aa2f7', textDecoration: 'none' }}>
          ← back to tasks
        </Link>
      </p>
    </div>
  );
}
