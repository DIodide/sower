import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { parseSocketUrl } from './index.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error('DATABASE_URL environment variable is required');
}

const migrationsFolder = fileURLToPath(new URL('../drizzle', import.meta.url));

const socket = parseSocketUrl(databaseUrl);
const client = socket
  ? postgres({ ...socket, max: 1 })
  : postgres(databaseUrl, { max: 1 });
const db = drizzle(client);

try {
  await migrate(db, { migrationsFolder });
  console.log(`Migrations applied successfully from ${migrationsFolder}`);
} finally {
  await client.end();
}
