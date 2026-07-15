import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  composeScheduleFile,
  createSchedule,
  fileScheduleId,
  FileScheduleRegistry,
  loadBuiltinSchedules,
  migrateCronRowsToStanding,
  parseScheduleFile,
  removeLegacySeededSchedules,
  startScheduler,
  standingSchedulesDir,
} from './index.js';
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
  let runtimeDir: string;
  const TZ = 'America/New_York';

  beforeEach(async () => {
    tdb = await createTestDb();
    runtimeDir = mkdtempSync(join(tmpdir(), 'sunny-sched-'));
    freezeTime(new Date('2026-01-01T12:00:00.000Z'));
  });
  afterEach(async () => {
    unfreezeTime();
    rmSync(runtimeDir, { recursive: true, force: true });
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

  it('the repo dreaming builtin carries the dream contract (portability D5)', () => {
    // Loaded from the actual agent/builtin/schedules/ files — the deployed file IS
    // the definition, so this locks the shipped contract, not a copy of it.
    const defs = loadBuiltinSchedules();
    const dream = defs.find((d) => d.name === 'dreaming');
    expect(dream).toBeDefined();
    expect(dream!.cron).toBe('30 */4 * * *');
    expect(dream!.audience).toBe('nobody'); // record-only — the silent maintenance case
    expect(dream!.authority).toEqual([
      'memory_read',
      'memory_write',
      'bash',
      'file_read',
      'file_write',
    ]);
    expect(dream!.prompt).toContain('dreaming skill');
  });

  it('file schedule ids are deterministic per (class, name); resolution fills machine fields', () => {
    const id = fileScheduleId('builtin', 'dreaming');
    expect(id).toBe(fileScheduleId('builtin', 'dreaming'));
    expect(id).not.toBe(fileScheduleId('builtin', 'other'));
    expect(id).not.toBe(fileScheduleId('standing', 'dreaming')); // classes never collide
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

    const def = parseScheduleFile(
      'dreaming',
      '---\ncron: "30 */4 * * *"\naudience: nobody\nauthority: memory_read, bash\n---\nDream.',
    );
    expect(def.authority).toEqual(['memory_read', 'bash']);
    expect(def.audience).toBe('nobody');
  });

  it('legacy outputTarget frontmatter migrates to the audience it implied (D-VL5)', () => {
    const silent = parseScheduleFile(
      'x',
      '---\ncron: "* * * * *"\noutputTarget: silent\n---\nbody',
    );
    expect(silent.audience).toBe('nobody');
    const user = parseScheduleFile('x', '---\ncron: "* * * * *"\noutputTarget: user\n---\nbody');
    expect(user.audience).toBeUndefined(); // absent → the owner's conversation loop
    // The composed round-trip never re-emits the retired key.
    expect(composeScheduleFile(silent)).not.toContain('outputTarget');
    expect(composeScheduleFile(silent)).toContain('audience: nobody');
  });

  it('parseScheduleFile rejects invalid definitions loudly', () => {
    expect(() => parseScheduleFile('x', 'no frontmatter')).toThrow(/missing frontmatter cron/);
    expect(() => parseScheduleFile('x', '---\ncron: "not a cron"\n---\nbody')).toThrow();
    expect(() => parseScheduleFile('x', '---\ncron: "* * * * *"\n---\n')).toThrow(
      /empty prompt body/,
    );
    expect(() =>
      parseScheduleFile('x', '---\ncron: "* * * * *"\noutputTarget: shout\n---\nbody'),
    ).toThrow(/invalid legacy outputTarget/);
    expect(() =>
      parseScheduleFile('x', '---\ncron: "* * * * *"\naudience: everyone\n---\nbody'),
    ).toThrow(/invalid audience/);
    // The pre-collapse spelling still parses, canonicalized.
    expect(
      parseScheduleFile('x', '---\ncron: "* * * * *"\naudience: household\n---\nbody').audience,
    ).toBe('nobody');
  });

  it('legacy files with BOTH audience and outputTarget parse with the audience winning (code-review)', () => {
    // The pre-collapse composeScheduleFile wrote `outputTarget:` UNCONDITIONALLY, so every
    // old file created with an explicit audience carries both keys — throwing here would
    // silently kill those schedules at boot (warn-and-skip). The audience wins, matching the
    // old runtime's fire-time precedence.
    const both = parseScheduleFile(
      'x',
      '---\ncron: "* * * * *"\naudience: person:Kate\noutputTarget: user\n---\nbody',
    );
    expect(both.audience).toBe('person:Kate');
    const silentBoth = parseScheduleFile(
      'x',
      '---\ncron: "* * * * *"\naudience: household\noutputTarget: silent\n---\nbody',
    );
    expect(silentBoth.audience).toBe('nobody');
    // And the rewrite drops the retired key entirely.
    expect(composeScheduleFile(both)).not.toContain('outputTarget');
  });

  it('load-time migration: legacy FRONTMATTER is rewritten once; a body mentioning outputTarget is not (code-review)', () => {
    const dir = standingSchedulesDir(runtimeDir);
    mkdirSync(dir, { recursive: true });
    // Legacy frontmatter → rewritten canonically on load, schedule still registered.
    writeFileSync(
      join(dir, 'legacy.md'),
      '---\ncron: "0 9 * * *"\noutputTarget: silent\n---\nDo the thing.\n',
    );
    // Canonical frontmatter whose BODY documents the file format — the detection must be
    // frontmatter-scoped or this file is rewritten (and state-committed) on EVERY boot.
    const canonical =
      '---\ncron: "0 9 * * *"\naudience: nobody\n---\nSchedule files once used outputTarget: user in frontmatter.\n';
    writeFileSync(join(dir, 'canonical.md'), canonical);

    const reg = FileScheduleRegistry.load({ runtimeDir, threadId: OWNER_THREAD, timezone: TZ });
    const legacy = reg.list().find((s) => s.label === 'legacy');
    expect(legacy?.audience).toBe('nobody');
    const rewritten = readFileSync(join(dir, 'legacy.md'), 'utf8');
    expect(rewritten).not.toContain('outputTarget');
    expect(rewritten).toContain('audience: nobody');
    // The canonical file is byte-untouched despite its body.
    expect(readFileSync(join(dir, 'canonical.md'), 'utf8')).toBe(canonical);
  });

  it('a standing schedule created live fires through dispatch under its stable id, and stops when deleted', async () => {
    const registry = new FileScheduleRegistry({ runtimeDir, threadId: OWNER_THREAD, timezone: TZ });

    const dispatched: string[] = [];
    startScheduler({
      db: tdb.db,
      files: registry,
      dispatch: async (schedule) => void dispatched.push(schedule.id),
    });
    await advanceTimersByTimeAsync(1_000);
    expect(dispatched).toEqual([]); // nothing registered yet

    // Created mid-flight: live without a restart, file committed under state/schedules/.
    const standing = await registry.createStanding({
      name: 'morning-briefing',
      cron: '*/5 * * * *',
      prompt: 'Follow your morning-briefing skill.',
    });
    expect(standing.fileClass).toBe('standing');
    expect(
      existsSync(join(standingSchedulesDir(runtimeDir), 'morning-briefing.md')),
    ).toBe(true);

    // First sighting seeds next-fire from the cron — never fires immediately...
    await advanceTimersByTimeAsync(60_000);
    expect(dispatched).toEqual([]);
    // ...then fires at the next occurrence (*/5 from 12:01 → 12:05).
    await advanceTimersByTimeAsync(4 * 60_000);
    expect(dispatched).toEqual([fileScheduleId('standing', 'morning-briefing')]);
    const runs = await tdb.db.select().from(scheduleRuns);
    expect(runs[0]?.scheduleId).toBe(fileScheduleId('standing', 'morning-briefing'));
    // No row was ever inserted into `schedules` — file schedules execute from files.
    expect(await tdb.db.select().from(schedules)).toHaveLength(0);

    // Deleting removes the file and stops firing.
    await registry.deleteStanding('morning-briefing');
    expect(
      existsSync(join(standingSchedulesDir(runtimeDir), 'morning-briefing.md')),
    ).toBe(false);
    await advanceTimersByTimeAsync(10 * 60_000);
    expect(dispatched).toHaveLength(1);
  });

  it('migrateCronRowsToStanding converts cron rows to standing files and deletes them', async () => {
    const registry = new FileScheduleRegistry({ runtimeDir, threadId: OWNER_THREAD, timezone: TZ });
    // A LEGACY row (pre-audience `output_target: silent`) inserted directly — the creation
    // surface no longer speaks outputTarget (D-VL5), but old rows must still migrate.
    await tdb.db.insert(schedules).values({
      kind: 'cron',
      spec: '0 5 * * *',
      prompt: 'Run the daily Craft resource-tagging job.',
      threadId: OWNER_THREAD,
      timezone: TZ,
      label: 'craft-daily-resource-tagging',
      outputTarget: 'silent',
      authority: ['memory_read', 'bash'],
      nextRunAt: new Date(Date.now() + 60_000),
      active: true,
    });
    await createSchedule(tdb.db, {
      kind: 'once',
      spec: '2026-06-01T12:00:00.000Z',
      prompt: 'one-off reminder stays',
      threadId: OWNER_THREAD,
      timezone: TZ,
    });

    await migrateCronRowsToStanding(tdb.db, registry);

    const rows = await tdb.db.select().from(schedules);
    expect(rows.map((r) => r.kind)).toEqual(['once']); // reminder row untouched
    const migrated = registry.list().find((f) => f.label === 'craft-daily-resource-tagging');
    expect(migrated?.fileClass).toBe('standing');
    expect(migrated?.spec).toBe('0 5 * * *');
    // The legacy silent flag became the audience it implied (D-VL5).
    expect(migrated?.audience).toBe('nobody');
    expect(migrated?.authority).toEqual(['memory_read', 'bash']);
    // Round-trips through the file on disk — in the audience format, never the retired key.
    const raw = readFileSync(
      join(standingSchedulesDir(runtimeDir), 'craft-daily-resource-tagging.md'),
      'utf8',
    );
    expect(raw).not.toContain('outputTarget');
    expect(parseScheduleFile('craft-daily-resource-tagging', raw).cron).toBe('0 5 * * *');
  });

  it('removeLegacySeededSchedules retires dreaming and nightly-consolidation rows', async () => {
    for (const label of ['nightly-consolidation', 'dreaming']) {
      await createSchedule(tdb.db, {
        kind: 'cron',
        spec: '0 3 * * *',
        prompt: 'legacy seeded row',
        threadId: OWNER_THREAD,
        timezone: TZ,
        label,
      });
    }
    await createSchedule(tdb.db, {
      kind: 'cron',
      spec: '0 9 * * *',
      prompt: 'user-created reminder',
      threadId: OWNER_THREAD,
      timezone: TZ,
      label: 'standup',
    });

    await removeLegacySeededSchedules(tdb.db);

    const rows = await tdb.db.select().from(schedules);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.label).toBe('standup');
  });
});
