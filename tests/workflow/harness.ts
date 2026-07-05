import { start } from 'workflow/api';
import type { MockResponseDescriptor } from '../../src/agent/mockModel.js';
import { ConversationStore } from '../../src/gateway/store.js';
import type { SunnyConfig } from '../../src/config/index.js';
import { initMemory } from '../../src/memory/index.js';
import { TEST_TURN_MODEL_KEY } from '../../src/agent/turnModel.js';
import {
  DelegationSupervisor,
  type SpawnInput,
  type SpawnResult,
} from '../../src/agent/delegationSupervisor.js';
import { steerChild as steerChildImpl } from '../../src/agent/delegation.js';
import { runSubagent } from '../../workflows/subagent.js';
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
  /** Delegation seams wired against the real WDK Local World (durable-subagents): start a child
   *  run via the supervisor, or steer one. `wake` is captured for assertions (no router in test). */
  spawnChild: (input: SpawnInput) => Promise<SpawnResult>;
  steerChild: (childThreadId: string, text: string) => Promise<boolean>;
  wakeCalls: string[];
}

/** Stand up a PGlite-backed test runtime and inject it for the workflow's steps.
 *  `runtimeExtras` merges extra seam fields onto the injected runtime — e.g.
 *  `translateOverride` (the translator test seam) or `recoverOverride`. */
export async function setupTestRuntime(
  configOverrides: Partial<SunnyConfig> = {},
  runtimeExtras: Record<string, unknown> = {},
): Promise<TestRuntimeCtx> {
  const db = await createTestDb();
  const config = makeConfig(configOverrides);
  await initMemory(config); // create the memory tree so instruction assembly reads clean files
  const store = new ConversationStore(db.db, 30);
  const gateway = new FakeGateway();

  // Delegation seams (durable-subagents): a real supervisor over the Local World, so a child
  // run actually starts + reports. `wake` is captured rather than re-routed (no router here).
  const wakeCalls: string[] = [];
  const wake = (threadId: string) => {
    wakeCalls.push(threadId);
  };
  const supervisor = new DelegationSupervisor(
    db.db,
    store,
    async (input) => {
      const run = await start(runSubagent, [input]);
      return { runId: run.runId, returnValue: run.returnValue };
    },
    wake,
  );
  const spawnChild = (input: SpawnInput) => supervisor.spawn(input);
  const steerChild = (childThreadId: string, text: string) =>
    steerChildImpl(db.db, store, childThreadId, text);

  g[RUNTIME_KEY] = Promise.resolve({
    config,
    gateway,
    store,
    db: db.db,
    wakeThread: wake,
    spawnChild,
    steerChild,
    // Hermetic default: the progress translator is always armed on conversational turns,
    // so any multi-step mock would otherwise reach a LIVE utility model. Tests that assert
    // translator behavior override this via runtimeExtras.
    translateOverride: () => '',
    ...runtimeExtras,
  });
  return { db, store, gateway, config, spawnChild, steerChild, wakeCalls };
}

/** Script the turn's model (reply text, tool calls, the silence sentinel, etc.). Sets the
 *  plain RESPONSES array on the seam global; the workflow's `setupTurn` step reads it and the
 *  body builds the mock (responses[N] is returned for the Nth model step). */
export function setTurnModel(responses: MockResponseDescriptor[]): void {
  g[TEST_TURN_MODEL_KEY] = responses;
}

/** Convenience: a turn that replies with one final text (text-as-reply). */
export function replyOnce(text: string): MockResponseDescriptor[] {
  return [{ type: 'text', text }];
}

export async function teardownTestRuntime(ctx: TestRuntimeCtx): Promise<void> {
  delete g[RUNTIME_KEY];
  delete g[TEST_TURN_MODEL_KEY];
  await ctx.db.teardown();
}
