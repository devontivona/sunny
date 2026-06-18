import { PGlite } from '@electric-sql/pglite';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import { sql } from 'drizzle-orm';
import { join } from 'node:path';
import { createDb, runMigrations, type Db } from '../src/db/client.js';
import * as schema from '../src/db/schema.js';

/**
 * In-process Postgres fixture (design D4 / task 2.3).
 *
 * Default: a fresh in-memory **PGlite** (real Postgres in WASM) per call, with
 * the project's actual Drizzle migrations applied — including the generated
 * `text_search` tsvector column + GIN index from `0001_fts.sql`, so the real
 * FTS/recall path is exercised (not a SQLite stand-in). No Docker, no daemon;
 * starts in tens of ms. Use one per test file for perfect isolation.
 *
 * Escape hatch: set `TEST_DATABASE_URL` to point at a real Postgres for the rare
 * case PGlite can't host (e.g. a full WDK durable run — single-connection PGlite
 * can't). Honored transparently here (design D5).
 */
export interface TestDb {
  db: Db;
  /** Release the engine (close the WASM instance or the real-PG pool). */
  teardown: () => Promise<void>;
}

const MIGRATIONS_FOLDER = join(process.cwd(), 'drizzle');

export async function createTestDb(): Promise<TestDb> {
  const override = process.env.TEST_DATABASE_URL;
  if (override) {
    // Real-Postgres escape hatch (D5): node-postgres + the standard migrator.
    // Used by the eval lane, which drives the real model and can't run on
    // single-connection PGlite (its fire-and-forget + streamed-turn concurrency
    // wedges the WASM engine). A pooled real Postgres handles it exactly like
    // production. Migrations are idempotent; truncate gives per-call isolation on
    // the shared database (eval cases run sequentially).
    const { db, pool } = createDb(override);
    await runMigrations(db);
    await db.execute(
      sql`TRUNCATE TABLE "messages", "schedules", "schedule_runs" RESTART IDENTITY CASCADE`,
    );
    return { db, teardown: () => pool.end() };
  }

  const client = new PGlite(); // in-memory (no data dir) → discarded on close
  const db = drizzlePglite(client, { schema, logger: process.env.SUNNY_DB_LOG === '1' });
  await migratePglite(db, { migrationsFolder: MIGRATIONS_FOLDER });
  // PgliteDatabase is API-compatible with the app's NodePgDatabase `Db` for the
  // queries we run; the cast keeps the production modules unaware of the engine.
  return {
    db: db as unknown as Db,
    teardown: () => client.close(),
  };
}
