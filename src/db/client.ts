import { join } from 'node:path';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { logger } from '../logger.js';
import * as schema from './schema.js';

const log = logger('db');

export type Db = NodePgDatabase<typeof schema>;

export interface DbHandle {
  db: Db;
  pool: pg.Pool;
}

/** Create the Postgres pool + Drizzle client. DATABASE_URL is env-only (D-PS5). */
export function createDb(connectionString: string): DbHandle {
  const pool = new pg.Pool({ connectionString });
  const db = drizzle(pool, { schema });
  return { db, pool };
}

/** Apply pending SQL migrations at startup (home-server self-migrate). */
export async function runMigrations(db: Db): Promise<void> {
  // Resolve from cwd (project root) so it works under Nitro's bundle too.
  const migrationsFolder = join(process.cwd(), 'drizzle');
  await migrate(db, { migrationsFolder });
  log.info('migrations applied');
}
