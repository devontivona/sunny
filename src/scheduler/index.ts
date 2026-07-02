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

/** Ensure the nightly memory-consolidation schedule exists (4.7, idempotent). */
export async function ensureConsolidationSchedule(
  db: Db,
  threadId: string,
  tz: string,
): Promise<void> {
  const existing = await db
    .select()
    .from(schedules)
    .where(eq(schedules.label, 'nightly-consolidation'));
  if (existing.length > 0) return;
  await createSchedule(db, {
    kind: 'cron',
    spec: '0 3 * * *', // 3am in the owner's timezone
    prompt:
      'Nightly memory consolidation: review the recent conversation and tidy the memory core — ' +
      'merge duplicate facts in USER.md, promote bulky detail into topic docs (with an INDEX ' +
      'line), and keep everything accurate and concise. Reply with a one-line summary of what ' +
      'you changed, or an empty reply if nothing needed tidying.',
    threadId,
    timezone: tz,
    label: 'nightly-consolidation',
    // Maintenance with no news value: record the outcome but send NO proactive message
    // (durable-subagents D-DS1/§3 — the fix for the unwanted 2am consolidation text).
    outputTarget: 'silent',
  });
  log.info('seeded nightly-consolidation schedule', { threadId });
}

export interface SchedulerDeps {
  db: Db;
  /** Dispatch a due schedule as a durable job; returns when the run is enqueued. */
  dispatch: (schedule: ScheduleRow, runId: string) => Promise<void>;
}

/** Start the ~60s ticker. Fires due schedules, advances next-run, records history. */
export function startScheduler(deps: SchedulerDeps): void {
  const { db, dispatch } = deps;

  async function tick(): Promise<void> {
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
      // Advance the schedule BEFORE dispatch so a slow/failed run can't double-fire.
      // Missed-fire policy: one-shots fire once then deactivate; recurring compute
      // the next occurrence forward from now (no backfill of missed occurrences).
      const next =
        s.kind === 'once' ? null : computeNextRun(s.kind as ScheduleKind, s.spec, now, s.timezone);
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
    }
  }

  // Run once on start (catch up one-shots that came due during downtime), then tick.
  void tick();
  setInterval(() => void tick(), TICK_MS);
  log.info('scheduler started', { tickMs: TICK_MS });
}
