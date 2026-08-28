'use client';

// Converges the FillJobPanel while a fill job is active: polls the job's
// status every 2s (the run-view.tsx poll idiom) and refreshes the route only
// when the panel would actually change. The panel mounts this ONLY for
// requested/claimed/running jobs, so a terminal refresh unmounts the loop;
// the 15-minute budget stops a wedged job from polling forever.

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { getFillJobStatus } from './actions';

const POLL_INTERVAL_MS = 2_000;
/** Stop polling after 15 minutes — a manual reload still converges later. */
const POLL_BUDGET_MS = 15 * 60_000;

export function FillJobRefresher({
  jobId,
  status,
  hasLiveView,
  hasReport,
}: {
  jobId: string;
  status: string;
  hasLiveView: boolean;
  hasReport: boolean;
}) {
  const router = useRouter();

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const deadline = Date.now() + POLL_BUDGET_MS;

    const tick = async () => {
      let result: Awaited<ReturnType<typeof getFillJobStatus>> | null = null;
      try {
        result = await getFillJobStatus(jobId);
      } catch {
        // Poll failures never stop the loop — the server may be redeploying.
      }
      if (cancelled) return;
      if (result?.ok && result.job) {
        const changed =
          result.job.status !== status ||
          result.job.hasLiveView !== hasLiveView ||
          result.job.hasReport !== hasReport;
        if (changed) {
          // The refreshed server render remounts this with the new snapshot
          // (or unmounts it on a terminal status) — no reschedule here.
          router.refresh();
          return;
        }
      }
      if (Date.now() >= deadline) return;
      timer = setTimeout(tick, POLL_INTERVAL_MS);
    };
    timer = setTimeout(tick, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [jobId, status, hasLiveView, hasReport, router]);

  return null;
}
