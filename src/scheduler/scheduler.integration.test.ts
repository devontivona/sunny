import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createSchedule, ensureConsolidationSchedule, startScheduler } from './index.js';
import { schedules, scheduleRuns, type ScheduleRow } from '../db/schema.js';
import { createTestDb, type TestDb } from '../../tests/db.js';
import { advanceTimersByTimeAsync, freezeTime, unfreezeTime } from '../../tests/time.js';
import { OWNER_THREAD } from '../../tests/factories.js';

/**
 * Scheduler ticker under fake timers + real DB (task 5.4). Fake timers drive the
 * ~60s `setInterval` without real waiting; PGlite is the real schedules store.
 */
describe('scheduler ticker (integration)', () => {
  let tdb: TestDb;
  const TZ = 'America/New_York';

  beforeEach(async () => {
    tdb = await createTestDb();
    freezeTime(new Date('2026-01-01T12:00:00.000Z'));
  });
  afterEach(async () => {
    unfreezeTime();
    await tdb.teardown();
  });

  it('dispatches a due one-shot, records a run, and deactivates it', async () => {
    // Due 1 minute ago → fires on the first tick.
    await createSchedule(tdb.db, {
      kind: 'once',
      spec: new Date('2026-01-01T11:59:00.000Z').toISOString(),
      prompt: 'do the thing',
      threadId: OWNER_THREAD,
      timezone: TZ,
    });

    const dispatched: ScheduleRow[] = [];
    startScheduler({
      db: tdb.db,
      dispatch: async (schedule) => void dispatched.push(schedule),
    });
    await advanceTimersByTimeAsync(1_000);

    expect(dispatched).toHaveLength(1);
    const [row] = await tdb.db.select().from(schedules);
    expect(row?.active).toBe(false); // one-shot deactivated
    expect(row?.nextRunAt).toBeNull();
    const runs = await tdb.db.select().from(scheduleRuns);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe('running');
  });

  it('advances nextRunAt for a recurring schedule instead of deactivating', async () => {
    await createSchedule(tdb.db, {
      kind: 'interval',
      spec: '30m',
      prompt: 'recurring',
      threadId: OWNER_THREAD,
      timezone: TZ,
    });
    // Force it due now.
    await tdb.db.update(schedules).set({ nextRunAt: new Date('2026-01-01T11:00:00.000Z') });

    startScheduler({ db: tdb.db, dispatch: async () => {} });
    await advanceTimersByTimeAsync(1_000);

    const [row] = await tdb.db.select().from(schedules);
    expect(row?.active).toBe(true);
    // nextRunAt advanced to now + 30m (now is the frozen 12:00:00Z).
    expect(row?.nextRunAt?.toISOString()).toBe('2026-01-01T12:30:00.000Z');
  });

  it('caps dispatch at MAX_PER_TICK (10) per tick', async () => {
    for (let i = 0; i < 15; i++) {
      await createSchedule(tdb.db, {
        kind: 'once',
        spec: new Date('2026-01-01T11:00:00.000Z').toISOString(),
        prompt: `job ${i}`,
        threadId: OWNER_THREAD,
        timezone: TZ,
      });
    }
    let count = 0;
    startScheduler({ db: tdb.db, dispatch: async () => void (count += 1) });
    await advanceTimersByTimeAsync(1_000);
    expect(count).toBe(10);
  });

  it('records a failed run when dispatch throws (and keeps ticking)', async () => {
    await createSchedule(tdb.db, {
      kind: 'once',
      spec: new Date('2026-01-01T11:00:00.000Z').toISOString(),
      prompt: 'will fail',
      threadId: OWNER_THREAD,
      timezone: TZ,
    });
    startScheduler({
      db: tdb.db,
      dispatch: async () => {
        throw new Error('dispatch boom');
      },
    });
    await advanceTimersByTimeAsync(1_000);
    const [run] = await tdb.db.select().from(scheduleRuns);
    expect(run?.status).toBe('failed');
    expect(run?.error).toMatch(/dispatch boom/);
  });

  it('ensureConsolidationSchedule is idempotent', async () => {
    await ensureConsolidationSchedule(tdb.db, OWNER_THREAD, TZ);
    await ensureConsolidationSchedule(tdb.db, OWNER_THREAD, TZ);
    const rows = await tdb.db
      .select()
      .from(schedules)
      .where(eq(schedules.label, 'nightly-consolidation'));
    expect(rows).toHaveLength(1);
  });
});
