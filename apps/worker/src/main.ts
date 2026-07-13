/**
 * Runnable entry (`pnpm --filter @sower/worker start`). There is no long-lived
 * worker daemon yet — the Workday browser tier (T1) is invoked per task via the
 * CLIs, which is what the observed first run uses:
 *   - `pnpm --filter @sower/worker recon <job-url>`  — validate selectors (read-only)
 *   - `pnpm --filter @sower/worker fill <taskId>`    — fill a task (env-gated)
 * See research/platforms/workday-phase2-runbook.md. T0 (network tier) runs
 * inside apps/api via @sower/platforms.
 */
console.log(
  'Workday browser tier (T1) is CLI-invoked per task — see `recon`/`fill` scripts and workday-phase2-runbook.md.',
);
process.exit(0);
