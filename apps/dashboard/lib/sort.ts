// The Applications workspace's sort modes (app/page.tsx `?sort=`):
// 'priority' — today's order (priority tiers, manual ranks in "Waiting on
// you", arrival/activity within a tier); 'recent' — every section by date
// added, newest first, priority and manual rank ignored (so drag-reorder is
// off in that mode: a hand-made order only means something within tiers).

export type SortMode = 'priority' | 'recent';

/** `?sort=` → a mode; anything but 'recent' is the default priority order. */
export function parseSortMode(value: string | null | undefined): SortMode {
  return value === 'recent' ? 'recent' : 'priority';
}

/** Newest arrival first (created_at desc); a missing created_at sinks. */
export function compareRecent(
  a: { createdAtMs: number },
  b: { createdAtMs: number },
): number {
  return b.createdAtMs - a.createdAtMs;
}
