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
  if (!socketHost?.startsWith('/')) return null;
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
export type ApiCall = typeof schema.apiCalls.$inferSelect;
export type NewApiCall = typeof schema.apiCalls.$inferInsert;
export type Document = typeof schema.documents.$inferSelect;
export type NewDocument = typeof schema.documents.$inferInsert;
export type JobDescription = typeof schema.jobDescriptions.$inferSelect;
export type NewJobDescription = typeof schema.jobDescriptions.$inferInsert;
export type IngestionRun = typeof schema.ingestionRuns.$inferSelect;
export type NewIngestionRun = typeof schema.ingestionRuns.$inferInsert;
export type InvestigationRun = typeof schema.investigationRuns.$inferSelect;
export type NewInvestigationRun = typeof schema.investigationRuns.$inferInsert;
// Named *Row to avoid colliding with @sower/platforms' WorkdaySession (the
// runtime cookies/CSRF object); this is the DB row that mirrors its state.
export type WorkdaySessionRow = typeof schema.workdaySessions.$inferSelect;
export type NewWorkdaySessionRow = typeof schema.workdaySessions.$inferInsert;
export type AgentHeartbeat = typeof schema.agentHeartbeats.$inferSelect;
export type NewAgentHeartbeat = typeof schema.agentHeartbeats.$inferInsert;
export type Resume = typeof schema.resumes.$inferSelect;
export type NewResume = typeof schema.resumes.$inferInsert;
export type ResumeRun = typeof schema.resumeRuns.$inferSelect;
export type NewResumeRun = typeof schema.resumeRuns.$inferInsert;
// Named *Row to avoid colliding with @sower/answers' Profile (the validated
// document type); this is the DB row that carries one as its jsonb `data`.
export type ProfileRow = typeof schema.profiles.$inferSelect;
export type NewProfileRow = typeof schema.profiles.$inferInsert;
