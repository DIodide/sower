import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.js';

export * from './schema.js';
export { schema };

export function createDb(connectionString: string) {
  const client = postgres(connectionString, { max: 5 });
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
