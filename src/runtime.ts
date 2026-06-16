import { createAgentRunner } from './agent/loop.js';
import { loadConfig, type SunnyConfig } from './config/index.js';
import { createDb, runMigrations } from './db/client.js';
import { ConversationStore } from './gateway/store.js';
import { SendblueGateway } from './gateway/sendblue.js';
import type { ChannelEvent, Gateway } from './gateway/types.js';
import { initMemory } from './memory/index.js';
import { logger } from './logger.js';

const log = logger('runtime');

export interface Runtime {
  config: SunnyConfig;
  gateway: Gateway;
  store: ConversationStore;
}

let startedPromise: Promise<Runtime> | null = null;

/**
 * Memoized startup shared by all entrypoints (Nitro routes + plugin). Runs once:
 * load config, connect Postgres + migrate, seed memory, wire the gateway. The
 * WDK Postgres world is started separately by the Nitro plugin.
 */
export function getRuntime(): Promise<Runtime> {
  if (!startedPromise) startedPromise = start();
  return startedPromise;
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

  const store = new ConversationStore(db, config.recentWindowSize);
  const gateway = new SendblueGateway({ config, store });

  if (process.env.SUNNY_ECHO === '1') {
    log.info('ECHO mode (Milestone A) — no LLM');
    gateway.onInbound(async (event: ChannelEvent) => {
      await gateway.send(event.threadId, { text: `echo: ${event.text}` });
    });
  } else {
    gateway.onInbound(createAgentRunner({ config, store, gateway }));
  }

  await gateway.start();
  log.info('runtime started');
  return { config, gateway, store };
}
