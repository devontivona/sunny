import type { LanguageModel } from 'ai';
import { TurnDispatcher } from '../src/agent/dispatcher.js';
import { createAgentRunner } from '../src/agent/loop.js';
import type { SunnyConfig } from '../src/config/index.js';
import type { Db } from '../src/db/client.js';
import { ConversationStore } from '../src/gateway/store.js';
import { FakeGateway } from './fakes/gateway.js';
import { FakeDurableStart } from './fakes/start.js';
import { makeConfig } from './factories.js';

/**
 * Runtime test-composition helper (task 2.5).
 *
 * Wires the seams — a mock (or real) model, the fake gateway, an in-process DB,
 * and the recording fake durable-`start` — into the REAL runtime: a real
 * `ConversationStore`, the real `createAgentRunner`, and the real `TurnDispatcher`
 * with the gateway's inbound handler bound to it. Injection happens at the exact
 * points production wires them, so there are no test-only branches in product
 * code (design "seams could diverge" mitigation).
 *
 * The DB is supplied by the caller (`createTestDb()`), so a loop test and an
 * eval share this composition and differ only in the DB + model.
 */
export interface TestRuntimeOptions {
  db: Db;
  /** The model under test — a mock for tests, a real model for evals. */
  model: LanguageModel;
  /** Defaults to `makeConfig()` (owner = Devon, fresh temp runtime dir). */
  config?: SunnyConfig;
}

export interface TestRuntime {
  config: SunnyConfig;
  db: Db;
  store: ConversationStore;
  gateway: FakeGateway;
  fakeStart: FakeDurableStart;
  runTurn: ReturnType<typeof createAgentRunner>;
  dispatcher: TurnDispatcher;
}

export function createTestRuntime(opts: TestRuntimeOptions): TestRuntime {
  const config = opts.config ?? makeConfig();
  const store = new ConversationStore(opts.db, config.recentWindowSize);
  const gateway = new FakeGateway();
  const fakeStart = new FakeDurableStart();
  const runTurn = createAgentRunner({
    config,
    store,
    gateway,
    db: opts.db,
    model: opts.model,
    start: fakeStart.start,
  });
  const dispatcher = new TurnDispatcher(runTurn, store);
  gateway.onInbound((event) => Promise.resolve(dispatcher.enqueue(event)));
  return { config, db: opts.db, store, gateway, fakeStart, runTurn, dispatcher };
}
