import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTestDb, type TestDb } from './db.js';

/**
 * Migrations apply clean on a fresh DB (task 5.1) — including the generated
 * `text_search` tsvector column and its GIN index from `0001_fts.sql`, which the
 * Drizzle schema can't express and only exist via the raw SQL migration.
 */
describe('migrations on a fresh PGlite database', () => {
  let tdb: TestDb;
  beforeAll(async () => {
    tdb = await createTestDb();
  });
  afterAll(async () => {
    await tdb.teardown();
  });

  it('creates the expected tables', async () => {
    const res = await tdb.db.execute<{ table_name: string }>(sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' ORDER BY table_name
    `);
    const names = res.rows.map((r) => r.table_name);
    expect(names).toEqual(expect.arrayContaining(['messages', 'schedules', 'schedule_runs']));
  });

  it('has the generated tsvector `text_search` column', async () => {
    const res = await tdb.db.execute<{ data_type: string; is_generated: string }>(sql`
      SELECT data_type, is_generated FROM information_schema.columns
      WHERE table_name = 'messages' AND column_name = 'text_search'
    `);
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]?.data_type).toBe('tsvector');
    expect(res.rows[0]?.is_generated).toBe('ALWAYS');
  });

  it('has the GIN full-text index and the dedup unique index', async () => {
    const res = await tdb.db.execute<{ indexname: string }>(sql`
      SELECT indexname FROM pg_indexes WHERE tablename = 'messages'
    `);
    const idx = res.rows.map((r) => r.indexname);
    expect(idx).toContain('messages_fts_idx');
    expect(idx).toContain('messages_channel_msgid_uniq');
  });
});
