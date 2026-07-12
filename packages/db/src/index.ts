import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.js';

export * from './schema.js';
export { schema };

/**
 * Cloud SQL's unix-socket convention (borrowed from node-postgres):
 *   postgres://user:pass@localhost/db?host=/cloudsql/<project:region:instance>
 * postgres-js ignores the ?host= query param entirely (it would silently dial
 * TCP to localhost), so we detect the form and pass explicit options instead —
 * a host option containing '/' makes postgres-js connect to
 * `${host}/.s.PGSQL.5432` as a unix socket.
 */
export function parseSocketUrl(connectionString: string): {
  host: string;
  database: string;
  username: string;
  password: string;
} | null {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    return null;
  }
  const socketHost = url.searchParams.get('host');
  if (!socketHost || !socketHost.startsWith('/')) return null;
  return {
    host: socketHost,
    database: url.pathname.replace(/^\//, ''),
    username: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
  };
}

export function createDb(connectionString: string) {
  const socket = parseSocketUrl(connectionString);
  const client = socket
    ? postgres({ ...socket, max: 5 })
    : postgres(connectionString, { max: 5 });
  return drizzle(client, { schema });
}

export type Database = ReturnType<typeof createDb>;

export type Job = typeof schema.jobs.$inferSelect;
export type NewJob = typeof schema.jobs.$inferInsert;
export type ApplicationTask = typeof schema.applicationTasks.$inferSelect;
export type NewApplicationTask = typeof schema.applicationTasks.$inferInsert;
export type Event = typeof schema.events.$inferSelect;
export type NewEvent = typeof schema.events.$inferInsert;
export type Answer = typeof schema.answers.$inferSelect;
export type NewAnswer = typeof schema.answers.$inferInsert;
export type Account = typeof schema.accounts.$inferSelect;
export type NewAccount = typeof schema.accounts.$inferInsert;
