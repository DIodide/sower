import Link from 'next/link';

export default function FollowupNotFound() {
  return (
    <div className="card" style={{ maxWidth: '36rem' }}>
      <h2 className="section-title" style={{ margin: '0 0 0.5rem' }}>
        Follow-up not found
      </h2>
      <p className="hint" style={{ margin: '0 0 1rem' }}>
        No follow-up exists with that id.
      </p>
      <Link href="/">← Back to applications</Link>
    </div>
  );
}
