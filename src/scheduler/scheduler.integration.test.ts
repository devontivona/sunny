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

  it('a schedule whose advance write throws does not abort the other due schedules (SchedCrash)', async () => {
    // Two due one-shots. Make the FIRST advance UPDATE throw: without per-schedule isolation the
    // throw propagates out of the for-loop and out of `tick` — rejecting the unobserved `void
    // tick()` promise (no process-level unhandledRejection handler → gateway crash) and never
    // dispatching the second schedule. With the fix, schedule one is logged-and-skipped and
    // schedule two still fires.
    for (let i = 0; i < 2; i++) {
      await createSchedule(tdb.db, {
        kind: 'once',
        spec: new Date('2026-01-01T11:00:00.000Z').toISOString(),
        prompt: `job ${i}`,
        threadId: OWNER_THREAD,
        timezone: TZ,
      });
    }
    // The advance UPDATE is the first `db.update` call inside the loop; throw on its first call.
    vi.spyOn(tdb.db, 'update').mockImplementationOnce(() => {
      throw new Error('advance boom');
    });

    let count = 0;
    startScheduler({ db: tdb.db, dispatch: async () => void (count += 1) });
    await advanceTimersByTimeAsync(1_000);

    // The bad schedule was skipped, the other still dispatched — the tick did not reject.
    expect(count).toBe(1);
  });

  it('overlapping ticks dispatch a due schedule exactly once (SchedDouble reentrancy guard)', async () => {
    await createSchedule(tdb.db, {
      kind: 'once',
      spec: new Date('2026-01-01T11:00:00.000Z').toISOString(),
      prompt: 'do it once',
      threadId: OWNER_THREAD,
      timezone: TZ,
    });

    // Park the FIRST tick at its advance UPDATE (after it has SELECTed the due row). Without the
    // reentrancy guard, the interval-fired second tick SELECTs the still-un-advanced row, advances
    // and dispatches it, and then the first tick resumes and dispatches it AGAIN → count 2. With
    // the guard the second tick short-circuits (`if (ticking) return`) → count 1.
    let releaseAdvance!: () => void;
    const advanceGate = new Promise<void>((r) => {
      releaseAdvance = r;
    });
    const realUpdate = tdb.db.update.bind(tdb.db);
    let gatedOnce = false;
    vi.spyOn(tdb.db, 'update').mockImplementation(((table: unknown) => {
      const builder: any = (realUpdate as any)(table);
      if (!gatedOnce) {
        gatedOnce = true;
        const realSet = builder.set.bind(builder);
        builder.set = (values: unknown) => {
          const setBuilder: any = realSet(values);
          const realWhere = setBuilder.where.bind(setBuilder);
          setBuilder.where = (cond: unknown) => advanceGate.then(() => realWhere(cond));
          return setBuilder;
        };
      }
      return builder;
    }) as any);

    let count = 0;
    startScheduler({ db: tdb.db, dispatch: async () => void (count += 1) });

    // Let the first tick reach (and park at) the gated advance, then fire the interval → second tick.
    await advanceTimersByTimeAsync(60_000); // TICK_MS
    // The first tick is parked before dispatch; the second tick was skipped by the guard.
    expect(count).toBe(0);

    // Release the first tick; it advances + dispatches exactly once.
    releaseAdvance();
    await advanceTimersByTimeAsync(0);
    expect(count).toBe(1);
    const runs = await tdb.db.select().from(scheduleRuns);
    expect(runs).toHaveLength(1);
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
