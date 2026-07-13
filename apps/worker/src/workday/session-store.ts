/**
 * Vault storage for captured Workday sessions. The implementation now lives in
 * @sower/platforms (storage-package-agnostic) so both the pipeline (apps/api)
 * and the broker (apps/worker) share ONE source of truth; re-exported here for
 * the worker's existing importers. `Storage` from @sower/storage satisfies the
 * `SessionVault` interface structurally.
 */
export {
  loadWorkdaySession,
  saveWorkdaySession,
  sessionStoragePath,
} from '@sower/platforms';
