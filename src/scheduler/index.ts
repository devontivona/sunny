import { CronExpressionParser } from 'cron-parser';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { and, eq, inArray, lte } from 'drizzle-orm';
import { builtinSchedulesDir } from '../agentDir.js';
import { stateDir } from '../config/index.js';
import type { Db } from '../db/client.js';
import { schedules, scheduleRuns, type ScheduleRow } from '../db/schema.js';
import { logger } from '../logger.js';
import { sanitizeSlug } from '../slug.js';
import { parseSkill } from '../skills/index.js';
import { commitState } from '../state/index.js';

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

// --- File-defined schedules (portability D5/D14) -----------------------------
// Two classes of schedule live as markdown FILES, not rows:
//   builtin  — `agent/builtin/schedules/<name>.md` (app repo; developer-owned; a code
//              deploy is the update channel)
//   standing — `~/.sunny/state/schedules/<name>.md` (state repo; agent/owner-owned; the
//              durable recurring intents that are part of the agent's IDENTITY — synced
//              and restored with the state clone, like memory and skills)
// Both are cron-only with a no-backfill policy, so due-ness is clock-derivable and no
// execution state needs persisting (run history still lands in `schedule_runs` under a
// deterministic id). The `schedules` TABLE holds only one-shot reminders — consumable
// event state. Frontmatter carries the definition; the body is the run prompt.
// Machine-specific values (owner-DM thread, timezone) resolve from config at load time;
// `audience` is a roster REFERENCE (`person:<name>`) resolved downstream at fire time —
// the roster itself stays in owner-only config (the trust anchor lives outside every
// agent-writable store, by design).

export type FileScheduleClass = 'builtin' | 'standing';

/** A file-defined schedule definition parsed from its markdown (pre-resolution). */
export interface FileScheduleDef {
  /** Filename stem — the schedule's stable name (also its run-history key via
   *  {@link fileScheduleId}). */
  name: string;
  cron: string;
  prompt: string;
  outputTarget: 'user' | 'silent';
  audience?: string;
  authority?: string[];
}

/** Fixed namespace for deterministic file-schedule ids (RFC 4122 v5). */
const FILE_SCHEDULE_NAMESPACE = 'b7fb0cbe-93c8-4f31-a3f5-0d1a1c1f5c4d';

/** Deterministic UUIDv5 for a file schedule: `schedule_runs.schedule_id` is a plain
 *  (unconstrained) uuid column, so file-schedule run history records under a stable
 *  per-(class, name) id — same across machines and restarts, no schema migration, and
 *  no practical collision with the `defaultRandom()` v4 ids of reminder rows. */
export function fileScheduleId(cls: FileScheduleClass, name: string): string {
  const ns = FILE_SCHEDULE_NAMESPACE.replace(/-/g, '');
  const nsBytes = Buffer.from(ns, 'hex');
  const hash = createHash('sha1').update(nsBytes).update(`${cls}:${name}`, 'utf8').digest();
  hash[6] = (hash[6]! & 0x0f) | 0x50; // version 5
  hash[8] = (hash[8]! & 0x3f) | 0x80; // RFC 4122 variant
  const hex = hash.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Where agent/owner-authored standing schedules live: inside the STATE repo, so they
 *  sync/restore with memory and credentials (portability D14). */
export function standingSchedulesDir(runtimeDir: string): string {
  return join(stateDir(runtimeDir), 'schedules');
}

/** Parse one schedule file (frontmatter + prompt body). Throws on an invalid
 *  definition — a broken builtin is a code bug and a broken standing file is a bad
 *  write, both surfaced to the caller, never silently skipped. */
export function parseScheduleFile(name: string, raw: string): FileScheduleDef {
  const { frontmatter, body } = parseSkill(raw);
  const cron = frontmatter.cron;
  if (!cron) throw new Error(`schedule file ${name}: missing frontmatter cron`);
  CronExpressionParser.parse(cron); // validate the expression at load time
  if (!body.trim()) throw new Error(`schedule file ${name}: empty prompt body`);
  const outputTarget = frontmatter.outputtarget ?? 'user';
  if (outputTarget !== 'user' && outputTarget !== 'silent') {
    throw new Error(`schedule file ${name}: invalid outputTarget '${outputTarget}'`);
  }
  const authority = frontmatter.authority
    ?.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    name,
    cron,
    prompt: body.trim(),
    outputTarget,
    audience: frontmatter.audience || undefined,
    authority: authority && authority.length > 0 ? authority : undefined,
  };
}

/** Compose a standing-schedule file from a definition (parse round-trips). */
export function composeScheduleFile(def: FileScheduleDef): string {
  const lines = ['---', `cron: "${def.cron}"`, `outputTarget: ${def.outputTarget}`];
  if (def.audience) lines.push(`audience: ${def.audience}`);
  if (def.authority && def.authority.length > 0)
    lines.push(`authority: ${def.authority.join(', ')}`);
  lines.push('---', def.prompt.trim(), '');
  return lines.join('\n');
}

/** Load every schedule definition from one directory of `<name>.md` files. */
export function loadScheduleDir(dir: string): FileScheduleDef[] {
  if (!existsSync(dir)) return [];
  const defs: FileScheduleDef[] = [];
  for (const entry of readdirSync(dir).sort()) {
    if (!entry.endsWith('.md')) continue;
    defs.push(parseScheduleFile(entry.slice(0, -3), readFileSync(join(dir, entry), 'utf8')));
  }
  return defs;
}

/** Load the builtin (repo-shipped) schedule definitions. */
export function loadBuiltinSchedules(): FileScheduleDef[] {
  return loadScheduleDir(builtinSchedulesDir());
}

/** A file schedule resolved against this machine's config: a `ScheduleRow`-shaped
 *  object (deterministic id, owner-DM thread, timezone filled in) so the existing
 *  dispatch/audience path treats it exactly like a persisted schedule. */
export type FileSchedule = ScheduleRow & { fileClass: FileScheduleClass };

function resolveFileSchedule(
  def: FileScheduleDef,
  cls: FileScheduleClass,
  threadId: string,
  timezone: string,
): FileSchedule {
  const now = new Date();
  return {
    fileClass: cls,
    id: fileScheduleId(cls, def.name),
    kind: 'cron',
    spec: def.cron,
    prompt: def.prompt,
    threadId,
    outputTarget: def.outputTarget,
    audience: def.audience ?? null,
    authority: def.authority ?? null,
    timezone,
    label: def.name,
    nextRunAt: computeNextRun('cron', def.cron, now, timezone),
    active: true,
    lastRunAt: null,
    createdAt: now,
  };
}

/** Input for creating a standing schedule (the scheduling tools' file path). */
export interface CreateStandingInput {
  name: string;
  cron: string;
  prompt: string;
  outputTarget?: 'user' | 'silent';
  audience?: string;
  authority?: string[];
}

/**
 * The live registry of file-defined schedules (portability D5/D14). Builtins are
 * static for the process lifetime (a code deploy changes them); standing schedules
 * are MUTABLE at runtime — the scheduling tools create/delete their files (with
 * commit-on-write to the state repo) and the registry keeps the in-memory view in
 * sync, so a new standing schedule is live without a restart. When the owner-DM
 * thread can't be resolved (no transport/identity yet), the registry is DISABLED:
 * definitions are unreadable-as-runnable, `list()` is empty, and creation refuses —
 * the boot warning tells the owner what to fix.
 */
export class FileScheduleRegistry {
  private readonly items = new Map<string, FileSchedule>();

  constructor(
    private readonly opts: {
      runtimeDir: string;
      /** Owner-DM thread for default delivery, or null when unresolvable (disabled). */
      threadId: string | null;
      timezone: string;
    },
  ) {}

  /** Load builtins (throw on error — code bug) + standing files (warn-and-skip on a
   *  malformed file — agent-authored data must not take the boot down). */
  static load(opts: {
    runtimeDir: string;
    threadId: string | null;
    timezone: string;
  }): FileScheduleRegistry {
    const reg = new FileScheduleRegistry(opts);
    if (!opts.threadId) return reg; // disabled: definitions exist but can't run
    for (const def of loadBuiltinSchedules()) reg.register(def, 'builtin');
    const dir = standingSchedulesDir(opts.runtimeDir);
    if (existsSync(dir)) {
      for (const entry of readdirSync(dir).sort()) {
        if (!entry.endsWith('.md')) continue;
        try {
          reg.register(
            parseScheduleFile(entry.slice(0, -3), readFileSync(join(dir, entry), 'utf8')),
            'standing',
          );
        } catch (err) {
          log.warn('skipping malformed standing schedule file', { entry, err: String(err) });
        }
      }
    }
    return reg;
  }

  get enabled(): boolean {
    return this.opts.threadId !== null;
  }

  private register(def: FileScheduleDef, cls: FileScheduleClass): FileSchedule {
    const resolved = resolveFileSchedule(def, cls, this.opts.threadId!, this.opts.timezone);
    this.items.set(resolved.id, resolved);
    return resolved;
  }

  list(): FileSchedule[] {
    return [...this.items.values()].sort((a, b) => (a.label ?? '').localeCompare(b.label ?? ''));
  }

  get(id: string): FileSchedule | undefined {
    return this.items.get(id);
  }

  /** Create a standing schedule: write its file into the state repo (commit-on-write)
   *  and register it live. Rejects when disabled or the name is taken (builtin or
   *  standing — one namespace keeps listings unambiguous). */
  async createStanding(input: CreateStandingInput): Promise<FileSchedule> {
    if (!this.opts.threadId) {
      throw new Error(
        'standing schedules need the messaging transport configured (owner identity + ' +
          'SENDBLUE_FROM_NUMBER) so their runs can deliver',
      );
    }
    const name = sanitizeSlug(input.name, 'schedule name');
    for (const item of this.items.values()) {
      if (item.label === name) {
        throw new Error(
          `a ${item.fileClass} schedule named "${name}" already exists — pick another label`,
        );
      }
    }
    CronExpressionParser.parse(input.cron); // validate before writing anything
    const def: FileScheduleDef = {
      name,
      cron: input.cron,
      prompt: input.prompt,
      outputTarget: input.outputTarget ?? 'user',
      audience: input.audience,
      authority: input.authority,
    };
    const dir = standingSchedulesDir(this.opts.runtimeDir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${name}.md`), composeScheduleFile(def), { mode: 0o644 });
    await commitState(this.opts.runtimeDir, `schedule: create standing ${name}`);
    const resolved = this.register(def, 'standing');
    log.info('standing schedule created', { name, cron: input.cron });
    return resolved;
  }

  /** Delete a standing schedule by id or name: remove the file (committed) and drop it
   *  from the live view. Returns the removed schedule, or null if not found. Builtins
   *  are not deletable here — they change by code deploy. */
  async deleteStanding(idOrName: string): Promise<FileSchedule | null> {
    const item = [...this.items.values()].find(
      (s) => s.fileClass === 'standing' && (s.id === idOrName || s.label === idOrName),
    );
    if (!item) return null;
    rmSync(join(standingSchedulesDir(this.opts.runtimeDir), `${item.label}.md`), { force: true });
    await commitState(this.opts.runtimeDir, `schedule: delete standing ${item.label}`);
    this.items.delete(item.id);
    log.info('standing schedule deleted', { name: item.label });
    return item;
  }
}

/** Retire rows the old insert-once seeders left in the `schedules` table (the
 *  dreaming/nightly-consolidation seeds) — those jobs are builtin file-defined now,
 *  and a leftover row would double-fire them. */
export async function removeLegacySeededSchedules(db: Db): Promise<void> {
  const legacy = await db
    .delete(schedules)
    .where(inArray(schedules.label, ['dreaming', 'nightly-consolidation']))
    .returning({ id: schedules.id, label: schedules.label });
  if (legacy.length > 0) {
    log.info('removed legacy seeded schedule rows (now builtin file-defined)', {
      labels: legacy.map((l) => l.label),
    });
  }
}

/**
 * One-time migration (portability D14): recurring cron ROWS become standing FILES —
 * they were always identity, not event state. Row fields map 1:1 onto frontmatter;
 * the row is deleted only after its file is committed. Active `interval` rows (none
 * have ever existed in practice) are left firing from the DB with a warning to
 * re-create them as cron. Idempotent: migrated rows are gone on the next boot.
 */
export async function migrateCronRowsToStanding(
  db: Db,
  registry: FileScheduleRegistry,
): Promise<void> {
  if (!registry.enabled) return; // can't resolve delivery yet; migrate on a later boot
  const rows = await db.select().from(schedules).where(eq(schedules.active, true));
  for (const row of rows) {
    if (row.kind === 'interval') {
      log.warn(
        'legacy interval schedule row left in DB — recurring schedules are cron-based ' +
          'standing files now; re-create it as cron',
        { id: row.id, label: row.label },
      );
      continue;
    }
    if (row.kind !== 'cron') continue;
    let name = row.label ? sanitizeSlug(row.label, 'schedule name') : `job-${row.id.slice(0, 8)}`;
    try {
      await registry.createStanding({
        name,
        cron: row.spec,
        prompt: row.prompt,
        outputTarget: row.outputTarget === 'silent' ? 'silent' : 'user',
        audience: row.audience ?? undefined,
        authority: row.authority ?? undefined,
      });
    } catch (err) {
      log.warn('could not migrate cron schedule row to a standing file', {
        id: row.id,
        label: row.label,
        err: String(err),
      });
      continue;
    }
    await db.delete(schedules).where(eq(schedules.id, row.id));
    log.info('migrated cron schedule row to a standing file', { name, id: row.id });
  }
}

export interface SchedulerDeps {
  db: Db;
  /** Dispatch a due schedule as a durable job; returns when the run is enqueued. */
  dispatch: (schedule: ScheduleRow, runId: string) => Promise<void>;
  /** File-defined schedules (builtin + standing, portability D5/D14) — read LIVE each
   *  tick so a standing schedule created mid-flight fires without a restart. Fired
   *  through the same dispatch; run history lands in `schedule_runs` under their
   *  deterministic ids. Due-state is in-memory (cron + no-backfill → a restart just
   *  fires forward). */
  files?: Pick<FileScheduleRegistry, 'list'>;
}

/** Start the ~60s ticker. Fires due schedules, advances next-run, records history. */
export function startScheduler(deps: SchedulerDeps): void {
  const { db, dispatch } = deps;
  // In-memory next-fire times for file schedules (definitions live in files, not rows).
  // Seeded from each schedule's load-time nextRunAt the first time it is seen — a
  // schedule created mid-flight starts at its next cron occurrence, never immediately.
  const fileNext = new Map<string, Date | null>();

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

      // File-defined schedules first (they're few and system/identity-critical). Advance
      // the in-memory next BEFORE dispatch (same double-fire discipline as rows); fires
      // count against the per-tick bound shared with persisted reminders.
      const fileSchedules = deps.files?.list() ?? [];
      const liveIds = new Set(fileSchedules.map((f) => f.id));
      for (const id of fileNext.keys()) if (!liveIds.has(id)) fileNext.delete(id); // deleted mid-flight
      let fired = 0;
      for (const b of fileSchedules) {
        if (fired >= MAX_PER_TICK) break;
        if (!fileNext.has(b.id)) {
          fileNext.set(b.id, b.nextRunAt); // first sighting (boot or live create)
        }
        const next = fileNext.get(b.id);
        if (!next || next > now) continue;
        fileNext.set(b.id, computeNextRun('cron', b.spec, now, b.timezone));
        fired += 1;
        try {
          const [run] = await db
            .insert(scheduleRuns)
            .values({ scheduleId: b.id, status: 'running' })
            .returning();
          if (!run) continue;
          log.info('file schedule firing', { class: b.fileClass, name: b.label, runId: run.id });
          try {
            await dispatch(b, run.id);
          } catch (err) {
            log.error('file-schedule dispatch failed', { name: b.label, err: String(err) });
            await db
              .update(scheduleRuns)
              .set({ status: 'failed', error: String(err) })
              .where(eq(scheduleRuns.id, run.id));
          }
        } catch (err) {
          log.error('file-schedule tick failed', { name: b.label, err: String(err) });
        }
      }

      let due: ScheduleRow[];
      try {
        due = await db
          .select()
          .from(schedules)
          .where(and(eq(schedules.active, true), lte(schedules.nextRunAt, now)))
          .limit(Math.max(0, MAX_PER_TICK - fired));
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
  log.info('scheduler started', {
    tickMs: TICK_MS,
    fileSchedules: (deps.files?.list() ?? []).map((b) => `${b.fileClass}:${b.label}`),
  });
}
