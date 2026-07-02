import { getRun, start as startWorkflow } from 'workflow/api';
import { and, desc, eq, sql } from 'drizzle-orm';
import { runScheduledJob } from '../workflows/scheduledJob.js';
import { DurableTurnRouter } from './agent/durableRouter.js';
import { DelegationSupervisor } from './agent/delegationSupervisor.js';
import { loadConfig, type SunnyConfig } from './config/index.js';
import { createDb, runMigrations, type Db } from './db/client.js';
import { messages } from './db/schema.js';
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

export function getRuntime(): Promise<Runtime> {
  const g = globalThis as Record<symbol, unknown>;
  if (!g[RUNTIME_KEY]) g[RUNTIME_KEY] = start();
  return g[RUNTIME_KEY] as Promise<Runtime>;
}

async function start(): Promise<Runtime> {
  const config = loadConfig();

  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is not set — the agent cannot call Opus.');
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
    // resumes on its own. Await those first (bounded) so they mark their messages BEFORE we
    // recover — otherwise recovery could start a duplicate run alongside the resuming orphan and
    // double-reply. (On a code-change deploy the orphan diverges and fails instead; awaiting it
    // then falls through to recovery, which is correct since a failed orphan marked nothing.)
    await adoptOrphanConversationRuns(db);
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
        await startWorkflow(runScheduledJob, [
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

/** Longest we wait on an in-flight conversation run at startup before proceeding to recovery
 *  anyway — a single turn is far shorter, so this only ever guards a wedged run. */
const ORPHAN_AWAIT_MS = 30_000;

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
 * Await any `runConversation` runs still RUNNING at startup (durable-main-loop restart-orphan
 * safety). A turn-run in flight when the gateway died resumes in the WDK world; letting it
 * finish (so it marks its messages) before restart-recovery prevents a duplicate run +
 * double-reply. Bounded per run so a wedged orphan can't block startup; failures (e.g. a
 * code-change replay divergence) are swallowed — recovery then handles those messages.
 */
async function adoptOrphanConversationRuns(db: Db): Promise<void> {
  let ids: string[] = [];
  try {
    const res = await db.execute(sql`
      select id from workflow.workflow_runs
      where name like '%runConversation%' and status = 'running'
      order by created_at asc limit 50
    `);
    ids = ((res as unknown as { rows: { id: string }[] }).rows ?? []).map((r) => String(r.id));
  } catch (err) {
    // WDK tables absent (e.g. first boot) or unreadable — nothing to adopt.
    log.debug('orphan-run query skipped', { err: String(err) });
    return;
  }
  if (ids.length === 0) return;
  log.info('awaiting in-flight conversation runs before recovery', { count: ids.length });
  await Promise.all(
    ids.map((id) => withTimeout(getRun(id).returnValue, ORPHAN_AWAIT_MS).catch(() => undefined)),
  );
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
