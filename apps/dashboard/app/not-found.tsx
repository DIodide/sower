import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="card" style={{ maxWidth: '36rem' }}>
      <h2 className="section-title" style={{ margin: '0 0 0.5rem' }}>
        404 — page not found
      </h2>
      <p className="hint" style={{ margin: '0 0 1rem' }}>
        This task, platform, or tenant does not exist (or has no data yet).
      </p>
      <Link href="/">← Back to applications</Link>
    </div>
  );
}
