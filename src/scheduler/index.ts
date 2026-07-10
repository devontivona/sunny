import { CronExpressionParser } from 'cron-parser';
import { and, eq, lte } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { schedules, scheduleRuns, type ScheduleRow } from '../db/schema.js';
import { logger } from '../logger.js';

const log = logger('scheduler');

/** How often the ticker checks for due schedules. */
const TICK_MS = 60_000;
/** Max schedules dispatched per tick (basic rate guard; D-SC6 — full caps in Phase 6). */
const MAX_PER_TICK = 10;

export type ScheduleKind = 'once' | 'interval' | 'cron';

export interface CreateScheduleInput {
  kind: ScheduleKind;
  /** once: ISO timestamp · interval: duration (e.g. '30m','2h','1d') · cron: 5-field expr */
  spec: string;
  prompt: string;
  threadId: string;
  timezone: string;
  label?: string;
  /** Output target for the fired run (durable-subagents D-DS1); defaults to 'user'. */
  outputTarget?: 'user' | 'silent';
  /** Explicit audience (run-audiences #4), e.g. `person:Kate` — the run is for that party
   *  regardless of the creating thread. Null/omitted → derived from threadId + outputTarget. */
  audience?: string;
  /** The grants the fired run is endowed ({ audience, authority }; D-RA5) — validated as a
   *  subset of the creator's authority at the tool layer. Omitted → the memory default. */
  authority?: string[];
}

/** Parse a duration like '45s', '30m', '2h', '1d' into milliseconds. */
export function parseDuration(spec: string): number {
  const m = /^(\d+)\s*(s|m|h|d)$/.exec(spec.trim());
  if (!m) throw new Error(`invalid interval '${spec}' (use e.g. 30m, 2h, 1d)`);
  const n = Number(m[1]);
  const unit = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as 's' | 'm' | 'h' | 'd'];
  return n * unit;
}

/** Next fire time for a schedule, or null if a one-shot has no future occurrence. */
export function computeNextRun(
  kind: ScheduleKind,
  spec: string,
  from: Date,
  timezone: string,
): Date | null {
  switch (kind) {
    case 'once': {
      const at = new Date(spec);
      if (Number.isNaN(at.getTime())) throw new Error(`invalid timestamp '${spec}'`);
      return at;
    }
    case 'interval':
      return new Date(from.getTime() + parseDuration(spec));
    case 'cron':
      return CronExpressionParser.parse(spec, { currentDate: from, tz: timezone }).next().toDate();
  }
}

export async function createSchedule(db: Db, input: CreateScheduleInput): Promise<ScheduleRow> {
  const nextRunAt = computeNextRun(input.kind, input.spec, new Date(), input.timezone);
  const [row] = await db
    .insert(schedules)
    .values({
      kind: input.kind,
      spec: input.spec,
      prompt: input.prompt,
      threadId: input.threadId,
      timezone: input.timezone,
      label: input.label ?? null,
      outputTarget: input.outputTarget ?? 'user',
      audience: input.audience ?? null,
      authority: input.authority ?? null,
      nextRunAt,
      active: true,
    })
    .returning();
  if (!row) throw new Error('failed to create schedule');
  log.info('schedule created', { id: row.id, kind: row.kind, spec: row.spec, nextRunAt });
  return row;
}

export async function listSchedules(db: Db): Promise<ScheduleRow[]> {
  return db.select().from(schedules).where(eq(schedules.active, true));
}

export async function deleteSchedule(db: Db, id: string): Promise<boolean> {
  const res = await db.delete(schedules).where(eq(schedules.id, id)).returning();
  return res.length > 0;
}

/**
 * Ensure the DREAMING schedule exists (context-lifecycle; idempotent on `label='dreaming'`),
 * retiring the legacy `nightly-consolidation` seed it replaces. The dream is a plain
 * scheduled run: silent (result recorded, nothing sent), skill-driven (the prompt points at
 * skill:dreaming; the procedure lives there, not here), and grant-scoped to exactly what the
 * job needs — memory + bash/file_read to run the `sunny dream` CLI. Never the spawn grants.
 */
export async function ensureDreamSchedule(db: Db, threadId: string, tz: string): Promise<void> {
  // The blind nightly pass this replaces (its only input was its own prompt — every
  // "nothing to consolidate" since June was structurally guaranteed).
  const legacy = await db
    .delete(schedules)
    .where(eq(schedules.label, 'nightly-consolidation'))
    .returning({ id: schedules.id });
  if (legacy.length > 0) log.info('removed legacy nightly-consolidation schedule');

  const existing = await db.select().from(schedules).where(eq(schedules.label, 'dreaming'));
  if (existing.length > 0) return;
  await createSchedule(db, {
    kind: 'cron',
    spec: '30 */4 * * *', // every 4 hours, off the hour
    prompt:
      'Dreaming (recurring memory maintenance): follow your dreaming skill — read its SKILL.md ' +
      'and execute the procedure exactly (digest via the sunny CLI, fold durable facts into ' +
      'memory, reconcile INDEX, write compaction summaries, advance the watermark). End with ' +
      'the one-line outcome the skill specifies.',
    threadId,
    timezone: tz,
    label: 'dreaming',
    // Maintenance with no news value: record the outcome but send NO proactive message.
    outputTarget: 'silent',
    // Bespoke grants (internal seeder, not the preset surface): memory duties + the bash/
    // file_read needed to run `sunny dream` and read skills, + file_write so the dream can
    // author/update a skill (procedures graduate out of memory via the skill-authoring
    // skill — file_write adds ergonomics, not privilege, since bash can already write).
    // No spawn/registry grants.
    authority: ['memory_read', 'memory_write', 'bash', 'file_read', 'file_write'],
  });
  log.info('seeded dreaming schedule', { threadId });
}

export interface SchedulerDeps {
  db: Db;
  /** Dispatch a due schedule as a durable job; returns when the run is enqueued. */
  dispatch: (schedule: ScheduleRow, runId: string) => Promise<void>;
}

/** Start the ~60s ticker. Fires due schedules, advances next-run, records history. */
export function startScheduler(deps: SchedulerDeps): void {
  const { db, dispatch } = deps;

  // Reentrancy guard (SchedDouble): a slow tick (blocked on dispatch or DB) must not overlap with
  // the next interval fire — two overlapping ticks could both read the same row as due (the advance
  // UPDATE hasn't committed yet) and dispatch it twice → duplicate scheduled texts. One in-process
  // ticker, so a boolean fully closes it: a fire that lands while a tick is in flight is skipped
  // (the still-due rows are simply picked up by the next tick).
  let ticking = false;

  async function tick(): Promise<void> {
    if (ticking) return;
    ticking = true;
    try {
      const now = new Date();
      let due: ScheduleRow[];
      try {
        due = await db
          .select()
          .from(schedules)
          .where(and(eq(schedules.active, true), lte(schedules.nextRunAt, now)))
          .limit(MAX_PER_TICK);
      } catch (err) {
        log.error('tick query failed', { err: String(err) });
        return;
      }

      for (const s of due) {
        // Per-schedule isolation (SchedCrash): the advance UPDATE + run INSERT + dispatch run
        // inside a try so a transient DB error on one schedule can't abort the rest of the tick —
        // and, since `tick` is invoked as `void tick()` with no process-level unhandledRejection
        // handler, can't reject an unobserved promise and crash the gateway. Log and continue.
        try {
          // Advance the schedule BEFORE dispatch so a slow/failed run can't double-fire.
          // Missed-fire policy: one-shots fire once then deactivate; recurring compute
          // the next occurrence forward from now (no backfill of missed occurrences).
          const next =
            s.kind === 'once'
              ? null
              : computeNextRun(s.kind as ScheduleKind, s.spec, now, s.timezone);
          await db
            .update(schedules)
            .set({ lastRunAt: now, nextRunAt: next, active: next !== null })
            .where(eq(schedules.id, s.id));

          const [run] = await db
            .insert(scheduleRuns)
            .values({ scheduleId: s.id, status: 'running' })
            .returning();
          if (!run) continue;

          log.info('schedule firing', { id: s.id, label: s.label, kind: s.kind, runId: run.id });
          try {
            await dispatch(s, run.id);
          } catch (err) {
            log.error('dispatch failed', { id: s.id, err: String(err) });
            await db
              .update(scheduleRuns)
              .set({ status: 'failed', error: String(err) })
              .where(eq(scheduleRuns.id, run.id));
          }
        } catch (err) {
          log.error('schedule tick failed', { id: s.id, err: String(err) });
        }
      }
    } finally {
      ticking = false;
    }
  }

  // Run once on start (catch up one-shots that came due during downtime), then tick.
  void tick();
  setInterval(() => void tick(), TICK_MS);
  log.info('scheduler started', { tickMs: TICK_MS });
}
