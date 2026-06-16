import { createAgentRunner } from './agent/loop.js';
import { loadConfig } from './config/index.js';
import { createDb, runMigrations } from './db/client.js';
import { initMemory } from './memory/index.js';
import { SendblueGateway } from './gateway/sendblue.js';
import { ConversationStore } from './gateway/store.js';
import type { ChannelEvent, Gateway } from './gateway/types.js';
import { logger } from './logger.js';
import { startHttpServer } from './server.js';

const log = logger('main');

// Load .env for local dev (secrets are env-only, D-PS5). No-op if absent.
try {
  process.loadEnvFile();
} catch {
  /* no .env file — fine in prod where systemd provides the EnvironmentFile */
}

async function main(): Promise<void> {
  const config = loadConfig();

  if (!process.env.ANTHROPIC_API_KEY) {
    log.error('ANTHROPIC_API_KEY is not set — the agent cannot call Opus. Aborting.');
    process.exit(1);
  }
  if (!process.env.DATABASE_URL) {
    log.error('DATABASE_URL is not set — the conversation store needs Postgres. Aborting.');
    process.exit(1);
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
  let gateway: Gateway;
  try {
    gateway = new SendblueGateway({ config, store });
  } catch (err) {
    log.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  // Milestone A (echo) vs Milestone B (real agent). SUNNY_ECHO=1 proves the
  // transport round-trip independent of the LLM (task 2.2).
  if (process.env.SUNNY_ECHO === '1') {
    log.info('starting in ECHO mode (Milestone A) — no LLM');
    gateway.onInbound(async (event: ChannelEvent) => {
      await gateway.send(event.threadId, { text: `echo: ${event.text}` });
    });
  } else {
    log.info('starting agent loop (Milestone B) — Opus replies');
    gateway.onInbound(createAgentRunner({ config, store, gateway }));
  }

  await gateway.start();
  startHttpServer(config, gateway);
}

main().catch((err) => {
  log.error('fatal startup error', { err: String(err) });
  process.exit(1);
});
