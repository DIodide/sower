/**
 * Runnable entry (`pnpm --filter @sower/worker start`). The worker has no
 * live behavior yet: T0 (network tier) runs inside apps/api via
 * @sower/platforms; the browser tiers are scaffolding only — see README.md.
 */
console.log('T1/T2/T3 browser tiers: scaffold only');
process.exit(0);
