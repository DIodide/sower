import { createDb, type Database } from '@sower/db';

// Cache the pool on globalThis so Next dev-mode module reloads (and the many
// route modules importing this file) share one postgres connection pool.
const globalStore = globalThis as unknown as {
  __sowerDashboardDb?: Database;
};

/**
 * Singleton drizzle database handle for the dashboard, connected via
 * DATABASE_URL. Throws a clear error when DATABASE_URL is not configured.
 */
export function getDb(): Database {
  if (!globalStore.__sowerDashboardDb) {
    const url = process.env.DATABASE_URL;
    if (!url) {
      throw new Error(
        'DATABASE_URL is not set. The sower dashboard needs a Postgres connection string, e.g. postgres://user:pass@localhost:5432/sower.',
      );
    }
    globalStore.__sowerDashboardDb = createDb(url);
  }
  return globalStore.__sowerDashboardDb;
}
