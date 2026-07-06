import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { memoizedStart, observeScheduledRun, type Runtime } from '../src/runtime.js';
import { scheduleRuns } from '../src/db/schema.js';
import { createTestDb } from './db.js';

/**
 * Runtime startup + scheduled-run observation regressions.
 *
 *  - R8: a transient boot failure must NOT pin a rejected promise forever — the next
 *    `getRuntime()` (via the shared `memoizedStart` memoizer) must retry `start()`.
 *  - SchedRun: a scheduled run that fails TERMINALLY must have its `schedule_runs` row recorded
 *    failed, not left stuck 'running' (the workflow marks its own row 'completed' only on the
 *    success path; a terminal failure never reaches that step).
 */

describe('memoizedStart (R8: transient boot failure is not pinned)', () => {
  it('clears the memo on rejection so the next call retries start()', async () => {
    const key = Symbol('test.runtime.r8');
    let calls = 0;
    const starter = async (): Promise<Runtime> => {
      calls += 1;
      if (calls === 1) throw new Error('Postgres briefly down');
      return { calls } as unknown as Runtime;
    };

    // First boot rejects (e.g. Postgres down in runMigrations).
    await expect(memoizedStart(key, starter)).rejects.toThrow('Postgres briefly down');

    // The rejected promise must have been cleared — the next call re-runs start() and succeeds,
    // instead of returning the pinned rejection forever.
    const rt = await memoizedStart(key, starter);
    expect(calls).toBe(2);
    expect(rt).toBeTruthy();

    // And once resolved it stays memoized (no third start()).
    await memoizedStart(key, starter);
    expect(calls).toBe(2);
  });
});

describe('observeScheduledRun (SchedRun: terminal failure is recorded)', () => {
  it('records a failed schedule_runs row when the run rejects terminally', async () => {
    const tdb = await createTestDb();
    try {
      const [run] = await tdb.db
        .insert(scheduleRuns)
        .values({ scheduleId: randomUUID(), status: 'running' })
        .returning();
      expect(run!.status).toBe('running');

      observeScheduledRun(
        tdb.db,
        run!.id,
        Promise.reject(new Error('agent step exhausted its retries')),
      );

      await vi.waitFor(
        async () => {
          const [row] = await tdb.db
            .select()
            .from(scheduleRuns)
            .where(eq(scheduleRuns.id, run!.id));
          expect(row!.status).toBe('failed');
          expect(row!.error).toContain('exhausted its retries');
        },
        { timeout: 3000 },
      );
    } finally {
      await tdb.teardown();
    }
  });

  it('leaves a successful run untouched (does not spuriously mark it failed)', async () => {
    const tdb = await createTestDb();
    try {
      const [run] = await tdb.db
        .insert(scheduleRuns)
        .values({ scheduleId: randomUUID(), status: 'completed', output: 'done' })
        .returning();

      observeScheduledRun(tdb.db, run!.id, Promise.resolve(undefined));

      // Give the (no-op) observer a beat, then confirm the row is unchanged.
      await new Promise((r) => setTimeout(r, 50));
      const [row] = await tdb.db.select().from(scheduleRuns).where(eq(scheduleRuns.id, run!.id));
      expect(row!.status).toBe('completed');
    } finally {
      await tdb.teardown();
    }
  });
});
