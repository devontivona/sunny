import { start as startWorkflow } from 'workflow/api';
import { and, desc, eq } from 'drizzle-orm';
import { runScheduledJob } from '../workflows/scheduledJob.js';
import { TurnDispatcher } from './agent/dispatcher.js';
import { createAgentRunner } from './agent/loop.js';
import { loadConfig, type SunnyConfig } from './config/index.js';
import { createDb, runMigrations, type Db } from './db/client.js';
import { messages } from './db/schema.js';
import { ConversationStore } from './gateway/store.js';
import { SendblueGateway } from './gateway/sendblue.js';
import type { ChannelEvent, Gateway } from './gateway/types.js';
import { initMemory } from './memory/index.js';
import { initSkills, startSkillSync } from './skills/index.js';
import { resolverFromEnv } from './credentials/index.js';
import { startScheduler } from './scheduler/index.js';
import { logger } from './logger.js';

const log = logger('runtime');

export interface Runtime {
  config: SunnyConfig;
  gateway: Gateway;
  store: ConversationStore;
  db: Db;
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

  const store = new ConversationStore(db, config.recentWindowSize);
  const gateway = new SendblueGateway({ config, store });

  let dispatcher: TurnDispatcher | null = null;
  if (process.env.SUNNY_ECHO === '1') {
    log.info('ECHO mode (Milestone A) — no LLM');
    gateway.onInbound(async (event: ChannelEvent) => {
      await gateway.send(event.threadId, { text: `echo: ${event.text}` });
    });
  } else {
    // Ack-fast turns through the dispatcher: per-thread serialization + steering
    // (4.1/4.1b). The gateway returns the webhook 200 immediately; turns run async.
    const runTurn = createAgentRunner({
      config,
      store,
      gateway,
      db,
      credentials: resolverFromEnv() ?? undefined,
      deliveryMode: config.deliveryMode,
    });
    dispatcher = new TurnDispatcher(runTurn, store);
    gateway.onInbound(async (event: ChannelEvent) => dispatcher!.enqueue(event));
  }

  await gateway.start();

  // Restart recovery (D-DE1): re-run any inbound message that was received but
  // never finished its turn (process died mid-turn). Delivery uses proactive send.
  if (dispatcher) {
    const unprocessed = await store.findUnprocessedInbound();
    if (unprocessed.length > 0) {
      log.info('recovering un-answered messages', { count: unprocessed.length });
      for (const event of unprocessed) dispatcher.enqueue(event);
    }
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
            threadId: schedule.threadId,
            prompt: schedule.prompt,
            ownerName: config.owner.name,
          },
        ]);
      },
    });
  }

  // Periodic skill-repo sync (D-SK8): keep the local clone fresh from the canonical
  // repo without a restart. initSkills synced once already; this is the ongoing
  // hourly cadence (ff-only). Reads are live, so a pull lands for the next turn.
  // On divergence Sunny tells the owner once (via the owner's DM thread, if known).
  startSkillSync({
    config,
    onDiverged: (text) => void notifyOwner(db, gateway, text),
  });

  log.info('runtime started');
  return { config, gateway, store, db };
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
