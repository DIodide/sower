import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error('DATABASE_URL environment variable is required');
}

const migrationsFolder = fileURLToPath(new URL('../drizzle', import.meta.url));

const client = postgres(databaseUrl, { max: 1 });
const db = drizzle(client);

try {
  await migrate(db, { migrationsFolder });
  console.log(`Migrations applied successfully from ${migrationsFolder}`);
} finally {
  await client.end();
}
