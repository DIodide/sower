// Route-level loading state: a slim indeterminate bar up top plus a few
// ghost rows in the existing tokens — flat, quiet, no spinners. (Under
// prefers-reduced-motion the global rule freezes the bar to a static
// accent strip.)

const SKELETON_ROWS = [0.62, 0.45, 0.7, 0.38, 0.55, 0.48] as const;

export default function Loading() {
  return (
    <div aria-busy="true">
      <div className="loading-bar" aria-hidden />
      <div className="skel-title" aria-hidden />
      <div className="row-list" aria-hidden>
        {SKELETON_ROWS.map((width, i) => (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder list — rows never reorder
            key={i}
            className="grid-row"
          >
            <span />
            <span />
            <span className="skel-line" style={{ width: `${width * 100}%` }} />
            <span className="skel-line" style={{ width: '55%' }} />
            <span className="skel-line" style={{ width: '40%' }} />
            <span className="skel-line" style={{ width: '100%' }} />
            <span />
          </div>
        ))}
      </div>
      <p className="sr-only" role="status">
        Loading…
      </p>
    </div>
  );
}
