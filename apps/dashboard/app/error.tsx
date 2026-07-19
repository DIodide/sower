'use client';

// Route-level error boundary. Its main job: recover gracefully from the
// stale-deploy failure mode — the tab was rendered by a previous deploy, the
// user clicks a button, and Next reports "Server Action ... was not found on
// the server" because that action id no longer exists. A reload gets the new
// build and the click works. We auto-reload ONCE per session for that case
// (guarded so a genuinely broken build can't reload-loop); anything else
// renders a plain retry card.
import { useEffect, useState } from 'react';

const STALE_ACTION_RE = /server action|failed to find/i;
const RELOAD_GUARD_KEY = 'sower-stale-action-reload';

export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const stale = STALE_ACTION_RE.test(error.message);
  const [reloading, setReloading] = useState(false);

  useEffect(() => {
    if (!stale) return;
    try {
      if (sessionStorage.getItem(RELOAD_GUARD_KEY)) return;
      sessionStorage.setItem(RELOAD_GUARD_KEY, '1');
    } catch {
      return; // storage unavailable — fall through to the manual card
    }
    setReloading(true);
    window.location.reload();
  }, [stale]);

  // A successful load means the new build took; clear the guard so a future
  // deploy can auto-recover again.
  useEffect(() => {
    if (stale) return;
    try {
      sessionStorage.removeItem(RELOAD_GUARD_KEY);
    } catch {
      // ignore
    }
  }, [stale]);

  if (reloading) {
    return (
      <div className="card">
        <p className="hint" style={{ margin: 0 }}>
          Sower was updated — refreshing to the new version…
        </p>
      </div>
    );
  }

  return (
    <div className="card">
      <h2 className="section-title" style={{ color: 'var(--danger-fg)' }}>
        {stale
          ? 'Sower was updated while this page was open'
          : 'Something went wrong'}
      </h2>
      <p className="hint" style={{ margin: '0.5rem 0 1rem' }}>
        {stale
          ? 'Reload to pick up the new version — your data is safe.'
          : (error.message ?? 'Unknown error.')}
      </p>
      <div className="row">
        {stale ? (
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => window.location.reload()}
          >
            Reload
          </button>
        ) : (
          <button type="button" className="btn" onClick={() => reset()}>
            Try again
          </button>
        )}
      </div>
    </div>
  );
}
