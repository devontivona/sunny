import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execMemoryWrite } from '../src/agent/tools/memory.js';
import { memoryPaths } from '../src/memory/index.js';
import type { SunnyConfig } from '../src/config/index.js';
import { createTestDb, type TestDb } from './db.js';
import { makeConfig } from './factories.js';

/**
 * Durable workflow step idempotency (task 5.8 / design risk note).
 *
 * WDK is experimental and doesn't run on PGlite (it needs multi-connection
 * LISTEN/NOTIFY), so we scope this to **step-function idempotency** — the
 * property the durable agent relies on — without standing up graphile_worker. A
 * `'use step'` is memoized by a deterministic step id: on replay the engine
 * returns the recorded result WITHOUT re-running `execute`. We model exactly that
 * memoization and assert a replayed `memory_write` applies its effect once,
 * against the real memory fs (PGlite stands in for the workflow store).
 *
 * Full crash/restart-resume is a boundary; if ever exercised it uses the
 * `TEST_DATABASE_URL` real-PG hatch and stays off the default gate.
 */

/** Models a WDK step boundary: run `fn` once per step id; replays return the cache. */
function makeReplayableSteps() {
  const cache = new Map<string, unknown>();
  return async function step<T>(id: string, fn: () => Promise<T>): Promise<T> {
    if (cache.has(id)) return cache.get(id) as T; // replay → no re-execution
    const result = await fn();
    cache.set(id, result);
    return result;
  };
}

describe('durable step idempotency', () => {
  let tdb: TestDb;
  let config: SunnyConfig;

  beforeEach(async () => {
    tdb = await createTestDb(); // the workflow store, present as in production
    config = makeConfig();
  });
  afterEach(async () => {
    await tdb.teardown();
  });

  it('memory_write `add` is NOT idempotent on its own (motivates the step boundary)', async () => {
    await execMemoryWrite(config, { file: 'USER', action: 'add', content: '- durable fact' });
    await execMemoryWrite(config, { file: 'USER', action: 'add', content: '- durable fact' });
    const body = readFileSync(memoryPaths(config.runtimeDir).USER, 'utf8');
    expect(body).toBe('- durable fact\n- durable fact\n'); // applied twice
  });

  it('a replayed memory_write step applies its effect exactly once', async () => {
    const step = makeReplayableSteps();
    const write = () =>
      step('write_step:1', () =>
        execMemoryWrite(config, { file: 'USER', action: 'add', content: '- durable fact' }),
      );

    const first = await write();
    const replay = await write(); // same step id → memoized, execute does NOT re-run

    expect(replay).toBe(first); // same recorded result
    const body = readFileSync(memoryPaths(config.runtimeDir).USER, 'utf8');
    expect(body).toBe('- durable fact\n'); // applied exactly once
  });
});
