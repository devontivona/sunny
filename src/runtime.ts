import { getRun, start as startWorkflow } from 'workflow/api';
import { and, desc, eq, sql } from 'drizzle-orm';
import { runScheduledJob } from '../workflows/scheduledJob.js';
import { DurableTurnRouter } from './agent/durableRouter.js';
import { DelegationSupervisor } from './agent/delegationSupervisor.js';
import { loadConfig, type SunnyConfig } from './config/index.js';
import { createDb, runMigrations, type Db } from './db/client.js';
import { messages, scheduleRuns } from './db/schema.js';
import { ConversationStore } from './gateway/store.js';
import { cleanupOutbox, ensureMediaDirs } from './gateway/media.js';
import { SendblueGateway } from './gateway/sendblue.js';
import { LoopbackGateway } from './gateway/loopback.js';
import { MultiChannelGateway } from './gateway/multiChannel.js';
import type { ChannelEvent, Gateway } from './gateway/types.js';
import { initMemory } from './memory/index.js';
import { initSkills, startSkillSync } from './skills/index.js';
import { pushState } from './state/index.js';
import { ensureConsolidationSchedule, startScheduler } from './scheduler/index.js';
import { sendblueDmThreadId } from './gateway/threadId.js';
import { normalize } from './gateway/auth.js';
import { scheduleAudience } from './agent/audience.js';
import { logger } from './logger.js';

const log = logger('runtime');

export interface Runtime {
  config: SunnyConfig;
  gateway: Gateway;
  store: ConversationStore;
  db: Db;
  /**
   * Wake a thread's run-supply (durable-subagents D-DS13): ensure the supervisor/router is
   * draining `threadId` as durable runs. Lets a `'use step'` (which can reach the runtime
   * singleton but not the in-process router directly — task 3.3) nudge it after writing to a
   * recipient's inbox — e.g. a child reporting to its parent. Optional: undefined in entrypoints
   * that don't run conversations (e.g. the ECHO mode).
   */
  wakeThread?: (threadId: string) => void;

  /**
   * Spawn a delegated child run (durable-subagents D-DS2). Reached from the `delegate_task`
   * tool's `'use step'`; routes to the in-process `DelegationSupervisor`, which enforces the
   * caps, starts the child, records the link, and arms the watchdog. Returns the child handle
   * immediately (non-blocking). Undefined when delegation isn't wired.
   */
  spawnChild?: (
    input: import('./agent/delegationSupervisor.js').SpawnInput,
  ) => Promise<import('./agent/delegationSupervisor.js').SpawnResult>;

  /** Steer a still-running child (durable-subagents D-DS4): append to its inbox; its in-flight
   *  run folds the steer via `loadSteers`. Reached from the `message_subagent` tool's step.
   *  Resolves `true` if delivered, `false` if the child already finished (so the caller can
   *  tell the model the truth instead of a false success). */
  steerChild?: (childThreadId: string, text: string) => Promise<boolean>;
}

/**
 * Memoized startup shared by all entrypoints (Nitro routes + plugin). Runs once:
 * load config, connect Postgres + migrate, seed memory, wire the gateway. The
 * WDK Postgres world is started separately by the Nitro plugin.
 *
 * The memo is pinned on `globalThis` (not a module-level `let`) so it survives
 * Vite's server-module re-evaluation in the unified dev server: a back-end edit
 * re-evals route modules but MUST NOT re-run startup, or each edit would leak a
 * new scheduler interval + Sendblue init + world subscription. In standalone
 * Nitro this is just a singleton (a no-op difference).
 */
const RUNTIME_KEY = Symbol.for('sunny.runtime');

/**
 * Memoize `starter()` on a `globalThis` slot, but CLEAR the slot if the promise REJECTS (R8) —
 * otherwise a transient boot failure (e.g. Postgres briefly down in `runMigrations`) pins a
 * rejected promise so every later `getRuntime()` rejects forever until a process restart. On a
 * rejection the next call re-runs `starter()`. Exported for the regression test.
 */
export function memoizedStart(key: symbol, starter: () => Promise<Runtime>): Promise<Runtime> {
  const g = globalThis as Record<symbol, unknown>;
  if (!g[key]) {
    const p = starter();
    p.catch(() => {
      // Only clear if still the same promise (a later successful start hasn't replaced it).
      if (g[key] === p) delete g[key];
    });
    g[key] = p;
  }
  return g[key] as Promise<Runtime>;
}

export function getRuntime(): Promise<Runtime> {
  return memoizedStart(RUNTIME_KEY, start);
}

async function start(): Promise<Runtime> {
  const config = loadConfig();

  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is not set — the agent cannot call the model.');
  }
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not set — the conversation store needs Postgres.');
  }
  if (config.owner.identities.length === 0) {
    log.warn(
      'No owner identities configured in ~/.sunny/config.json — every DM will be ' +
        'unauthorized. Add your iMessage phone/email to owner.identities.',
    );
  }

  const { db } = createDb(process.env.DATABASE_URL);
  await runMigrations(db);
  await initMemory(config);
  await initSkills(config);

  // Media storage (messaging-media D-MM2/4): create + gitignore the media tree,
  // and sweep the short-TTL public outbox hourly so hosted send-files don't pile
  // up. Inbound media is retained durably (cleanup deferred).
  ensureMediaDirs(config.runtimeDir);
  cleanupOutbox(config.runtimeDir, Date.now());
  setInterval(() => cleanupOutbox(config.runtimeDir, Date.now()), 60 * 60_000).unref();

  const store = new ConversationStore(db, config.recentWindowSize);
  // Channels (durable-main-loop test infra): real Sendblue/iMessage is always wired. With
  // SUNNY_TEST_CHANNEL=1 the programmatic loopback channel is added ALONGSIDE it via a
  // MultiChannelGateway that routes by thread — `loopback:` threads go to the test channel
  // (drive full turns over HTTP), everything else to iMessage. So iMessage stays fully live
  // while a test thread is driven; default OFF → production is the bare Sendblue gateway.
  const sendblue = new SendblueGateway({ config, store });
  let gateway: Gateway = sendblue;
  if (process.env.SUNNY_TEST_CHANNEL === '1') {
    log.info('test channel enabled (loopback alongside Sendblue; SUNNY_TEST_CHANNEL=1)');
    gateway = new MultiChannelGateway(sendblue, new LoopbackGateway({ config, store }));
  }

  // Two inbound paths: ECHO (no LLM) and the durable Tier-1 loop — each turn is a per-thread
  // `runConversation` workflow run (durable-main-loop). The durable path is now the default and
  // sole conversational path; its per-thread run subsumes what was the in-process dispatcher's
  // serialization/steering and the D-DE1 restart-recovery pass (both fold into the WDK runtime).
  let durableRouter: DurableTurnRouter | null = null;
  if (process.env.SUNNY_ECHO === '1') {
    log.info('ECHO mode (Milestone A) — no LLM');
    gateway.onInbound(async (event: ChannelEvent) => {
      await gateway.send(event.threadId, { text: `echo: ${event.text}` });
    });
  } else {
    // Route each inbound to its thread's durable conversational run (start / resume / rebind),
    // and refresh typing from the run's output stream.
    durableRouter = new DurableTurnRouter(gateway, store, {
      modelId: config.modelId,
      effort: config.thinking === 'off' ? null : config.effort,
      turnWatchdogMs: config.turnWatchdogMs,
    });
    gateway.onInbound(async (event: ChannelEvent) => durableRouter!.route(event));
  }

  // Delegation seams (durable-subagents D-DS2/4/13): the in-process supervisor is the run-supply
  // engine for single-run children + the watchdog. A child's report lands on its PARENT's thread —
  // for top-level Sunny that's the owner conversation thread the router already drives — so
  // `wakeThread` is just `router.wake`. `spawnChild`/`steerChild` give a `'use step'` a path to the
  // in-process supervisor it can't reach directly (task 3.3). All undefined in ECHO (no router).
  let wakeThread: ((threadId: string) => void) | undefined;
  let spawnChild: Runtime['spawnChild'];
  let steerChild: Runtime['steerChild'];
  let supervisor: DelegationSupervisor | null = null;
  if (durableRouter) {
    const router = durableRouter;
    wakeThread = (threadId) => router.wake(threadId);
    const sup = new DelegationSupervisor(
      db,
      store,
      async (input) => {
        const { runSubagent } = await import('../workflows/subagent.js');
        const run = await startWorkflow(runSubagent, [input]);
        return { runId: run.runId, returnValue: run.returnValue };
      },
      wakeThread,
    );
    supervisor = sup;
    spawnChild = (input) => sup.spawn(input);
    steerChild = async (childThreadId, text) => {
      const { steerChild: steer } = await import('./agent/delegation.js');
      return steer(db, store, childThreadId, text);
    };
  }

  await gateway.start();

  // Restart recovery: re-run any inbound received but never answered (process died mid-turn).
  if (durableRouter) {
    // A turn-run that was in flight when the gateway died is still RUNNING in the WDK world and
    // resumes on its own. ADOPT those into the router first: each orphan is driven through the
    // full turn machinery (stream bridge → typing + live pane, watchdog, explicit abandon)
    // inside its thread's serial worker, so the recovery pass below queues BEHIND it instead of
    // racing it into a duplicate reply (2026-07-05: the old 30s global await expired under a
    // healthy 7-minute orphan and recovery double-answered the same inbound — the PR #29 class).
    await adoptOrphanConversationRuns(db, durableRouter);
    const unprocessed = await store.findUnprocessedInbound();
    if (unprocessed.length > 0) {
      log.info('recovering un-answered messages', { count: unprocessed.length });
      await durableRouter.recoverPending(unprocessed);
    }
    if (supervisor) await reattachRunningChildren(db, supervisor);
  }

  // Scheduling (D-SC2): the ~60s ticker dispatches due schedules as durable jobs.
  // SUNNY_DISABLE_SCHEDULER=1 lets a second instance run without scheduling — e.g.
  // the unified dashboard service during the interim where it overlaps the legacy
  // gateway against one DB (avoids double-firing schedules until cutover).
  if (process.env.SUNNY_DISABLE_SCHEDULER === '1') {
    log.warn(
      'scheduler disabled (SUNNY_DISABLE_SCHEDULER=1) — this instance will not fire schedules',
    );
  } else {
    startScheduler({
      db,
      dispatch: async (schedule, runId) => {
        const run = await startWorkflow(runScheduledJob, [
          {
            scheduleId: schedule.id,
            runId,
            prompt: schedule.prompt,
            ownerName: config.owner.name,
            // Address the fired run by the schedule's audience (run-audiences D-RA11/#4): an
            // explicit `person:` (scheduled FOR someone), else its creating thread, else
            // `household` (record-only) for a silent maintenance schedule.
            audience: scheduleAudience(schedule),
          },
        ]);
        // Observe the terminal outcome (SchedRun): the workflow marks its OWN schedule_runs row
        // 'completed' on success, but a TERMINAL failure never reaches that step — without this
        // the row would stay 'running' forever and the occurrence be silently lost. Non-blocking
        // (don't hold the tick): record the failure out of band.
        observeScheduledRun(db, runId, run.returnValue);
      },
    });
  }

  // Seed the nightly memory-consolidation schedule (run-audiences Phase 1a: restore the caller
  // the durable-main-loop migration dropped, so fresh installs get consolidation again).
  // Idempotent (keyed on its label) and delivered `silent`. Addressed to the owner's DM thread,
  // constructed deterministically from config + SENDBLUE_FROM_NUMBER so it needs no prior inbound.
  try {
    const ownerId = config.owner.identities[0];
    const from = process.env.SENDBLUE_FROM_NUMBER;
    if (ownerId && from) {
      await ensureConsolidationSchedule(
        db,
        sendblueDmThreadId(from, normalize(ownerId)),
        config.timezone,
      );
    } else {
      log.info('nightly-consolidation seed skipped — owner identity or SENDBLUE_FROM_NUMBER unset');
    }
  } catch (err) {
    log.warn('nightly-consolidation seed failed (non-fatal)', { err: String(err) });
  }

  // Periodic skill-repo sync (D-SK8): keep the local clone fresh from the canonical
  // repo without a restart. initSkills synced once already; this is the ongoing
  // cadence (every 10 min, ff-only). Reads are live, so a pull lands for the next turn.
  // On divergence Sunny tells the owner once (via the owner's DM thread, if known).
  // The same tick also pushes the `state` repo to its private remote best-effort
  // (runtime-home, task 2.4): commits land per-write, network sync batches here.
  startSkillSync({
    config,
    onDiverged: (text) => void notifyOwner(db, gateway, text),
    onTick: () => pushState(config),
  });

  log.info('runtime started');
  return { config, gateway, store, db, wakeThread, spawnChild, steerChild };
}

/** Fallback bound for an orphan run whose thread id can't be recovered from the WDK run
 *  record (it then can't be routed to a serial worker — we just await it before recovery,
 *  the pre-adoption behavior). A wedged one can't block startup past this. */
const ORPHAN_AWAIT_MS = 30_000;

/**
 * Observe a dispatched scheduled run's terminal outcome (SchedRun). The workflow marks its own
 * `schedule_runs` row 'completed' on success, but a TERMINAL failure (the agent step exhausted its
 * retries) never reaches that step — so without observing `returnValue` the row is left stuck
 * 'running' and the occurrence silently lost, with no reattach/watchdog like delegation children
 * have. Non-blocking: record the failure out of band. Exported for the regression test.
 */
export function observeScheduledRun(db: Db, runId: string, returnValue: Promise<unknown>): void {
  void returnValue.catch(async (err) => {
    log.error('scheduled run failed terminally', { runId, err: String(err) });
    await db
      .update(scheduleRuns)
      .set({ status: 'failed', error: String(err) })
      .where(eq(scheduleRuns.id, runId))
      .catch((e) => log.warn('could not record scheduled-run failure', { runId, err: String(e) }));
  });
}

/**
 * Re-arm the delegation watchdog for children still marked `running` at startup (durable-subagents
 * D-DS6). The watchdog is in-memory, so a child in flight across a restart would otherwise have no
 * one observing its `returnValue`: if it then failed, its link would leak as `running` forever
 * (a permanently-consumed concurrency slot) and the parent would never hear of the failure. For
 * each running link we re-subscribe to the durable run's `returnValue` and hand it to the
 * supervisor (which closes the link / reports failure on terminal outcome). A link with no recorded
 * run id (a crash in the gap between createLink and setChildRunId) can't be watched, so we free its
 * slot by marking it failed. Best-effort + non-blocking — never blocks startup.
 */
async function reattachRunningChildren(db: Db, supervisor: DelegationSupervisor): Promise<void> {
  try {
    const { listRunningLinks, completeLink } = await import('./agent/delegation.js');
    const links = await listRunningLinks(db);
    if (links.length === 0) return;
    log.info('re-attaching delegation watchdogs', { count: links.length });
    for (const link of links) {
      if (!link.childRunId) {
        await completeLink(db, link.childThreadId, 'failed').catch(() => {});
        continue;
      }
      try {
        const rv = getRun<unknown>(link.childRunId).returnValue;
        supervisor.reattach(link.childThreadId, link.parentThreadId, 'subagent', rv);
      } catch {
        await completeLink(db, link.childThreadId, 'failed').catch(() => {});
      }
    }
  } catch (err) {
    log.warn('child watchdog re-attach failed (non-fatal)', { err: String(err) });
  }
}

/**
 * Adopt any `runConversation` runs still RUNNING at startup into the router (durable-main-loop
 * restart-orphan safety). A turn-run in flight when the gateway died resumes in the WDK world;
 * the router drives it exactly like a fresh turn (bridge/typing/watchdog) inside the thread's
 * serial worker, so recovery for that thread queues behind it — never a duplicate run. The
 * thread id comes from the run record's serialized input (the WDK devalue text format,
 * `devl[[…],{"threadId":"…"}…]`); a run whose thread id can't be recovered falls back to a
 * bounded bare await (the pre-adoption behavior). Failures (e.g. a code-change replay
 * divergence) surface through the router's normal turn-failure path; recovery then handles
 * those messages.
 */
async function adoptOrphanConversationRuns(db: Db, router: DurableTurnRouter): Promise<void> {
  let rows: { id: string; threadId?: string }[] = [];
  try {
    const res = await db.execute(sql`
      select id, convert_from(input_cbor, 'utf8') as input_text from workflow.workflow_runs
      where name like '%runConversation%' and status = 'running'
      order by created_at asc limit 50
    `);
    rows = (
      (res as unknown as { rows: { id: string; input_text: string | null }[] }).rows ?? []
    ).map((r) => ({
      id: String(r.id),
      threadId: /"threadId":"([^"]+)"/.exec(r.input_text ?? '')?.[1],
    }));
  } catch (err) {
    // WDK tables absent (e.g. first boot) or unreadable — nothing to adopt.
    log.debug('orphan-run query skipped', { err: String(err) });
    return;
  }
  if (rows.length === 0) return;
  log.info('adopting in-flight conversation runs', {
    count: rows.length,
    unrouted: rows.filter((r) => !r.threadId).length,
  });
  const unrouted: Promise<unknown>[] = [];
  for (const row of rows) {
    const run = getRun(row.id);
    if (row.threadId) {
      router.adoptRun(row.threadId, {
        runId: row.id,
        returnValue: run.returnValue as Promise<void>,
        cancel: () => (run as unknown as { cancel: () => Promise<void> }).cancel(),
      });
    } else {
      unrouted.push(withTimeout(run.returnValue, ORPHAN_AWAIT_MS).catch(() => undefined));
    }
  }
  await Promise.all(unrouted);
}

/** Resolve with `undefined` if `p` hasn't settled within `ms` (the timer never holds the
 *  process open). */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  return Promise.race([
    p,
    new Promise<undefined>((resolve) => {
      const t = setTimeout(() => resolve(undefined), ms);
      t.unref();
    }),
  ]);
}

/** Send an owner-only maintenance notice to the owner's most recent DM thread (not a
 *  group). Best-effort: if no owner DM is known yet, just log. Mirrors the dashboard's
 *  in-process owner notify (a fixed template; not persisted to history). */
async function notifyOwner(db: Db, gateway: Gateway, text: string): Promise<void> {
  try {
    const recent = await db
      .select()
      .from(messages)
      .where(and(eq(messages.isOwner, true), eq(messages.role, 'user')))
      .orderBy(desc(messages.timestamp))
      .limit(25);
    const thread = recent.find((m) => m.threadId.split(':')[2] !== 'g')?.threadId;
    if (!thread) {
      log.warn('skill-sync notice skipped — no owner DM thread known yet', { text });
      return;
    }
    await gateway.send(thread, { text }, { persist: false });
  } catch (err) {
    log.warn('could not send skill-sync notice to owner', { err: String(err) });
  }
}
