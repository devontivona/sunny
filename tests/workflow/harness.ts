import type { MockResponseDescriptor } from '../../src/agent/mockModel.js';
import { ConversationStore } from '../../src/gateway/store.js';
import type { SunnyConfig } from '../../src/config/index.js';
import { initMemory } from '../../src/memory/index.js';
import { TEST_TURN_MODEL_KEY } from '../../src/agent/turnModel.js';
import { createTestDb, type TestDb } from '../db.js';
import { FakeGateway } from '../fakes/gateway.js';
import { makeConfig } from '../factories.js';

/**
 * Harness for `@workflow/vitest` workflow integration tests (durable-main-loop). The
 * workflow runs in the in-process Local World; its `'use step'` units run in real Node and
 * call `getRuntime()`, so we INJECT a test runtime (PGlite store + FakeGateway + temp config)
 * on the same `globalThis` key the production memo uses — `getRuntime()` returns it instead of
 * booting Postgres/Sendblue. The turn's model is overridden with a serialisable mock via the
 * `getTurnModel` seam, so a real turn streams without calling the live model.
 */
const RUNTIME_KEY = Symbol.for('sunny.runtime');
const g = globalThis as Record<symbol, unknown>;

export type { MockResponseDescriptor };

export interface TestRuntimeCtx {
  db: TestDb;
  store: ConversationStore;
  gateway: FakeGateway;
  config: SunnyConfig;
}

/** Stand up a PGlite-backed test runtime and inject it for the workflow's steps. */
export async function setupTestRuntime(): Promise<TestRuntimeCtx> {
  const db = await createTestDb();
  const config = makeConfig();
  await initMemory(config); // create the memory tree so instruction assembly reads clean files
  const store = new ConversationStore(db.db, 30);
  const gateway = new FakeGateway();
  g[RUNTIME_KEY] = Promise.resolve({ config, gateway, store, db: db.db });
  return { db, store, gateway, config };
}

/** Script the turn's model (a `send_message`/`stay_silent` tool call, text, etc.). Sets the
 *  plain RESPONSES array on the seam global; the workflow's `setupTurn` step reads it and the
 *  body builds the mock (responses[N] is returned for the Nth model step). */
export function setTurnModel(responses: MockResponseDescriptor[]): void {
  g[TEST_TURN_MODEL_KEY] = responses;
}

/** Convenience: a turn that delivers one message then stops. */
export function sendOnce(text: string): MockResponseDescriptor[] {
  return [
    { type: 'tool-call', toolName: 'send_message', input: JSON.stringify({ text }) },
    { type: 'text', text: '' },
  ];
}

export async function teardownTestRuntime(ctx: TestRuntimeCtx): Promise<void> {
  delete g[RUNTIME_KEY];
  delete g[TEST_TURN_MODEL_KEY];
  await ctx.db.teardown();
}
