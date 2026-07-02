import { afterEach, describe, expect, it } from 'vitest';
import { start } from 'workflow/api';
import { runJob } from '../../workflows/job.js';
import {
  setTurnModel,
  setupTestRuntime,
  teardownTestRuntime,
  type TestRuntimeCtx,
} from './harness.js';

/**
 * `runJob` against a real in-process WDK Local World (durable-subagents tasks 1.4 / 2.x;
 * run-audiences D-RA15). Verifies the background-job profile delivers its final text through the
 * SHARED delivery bus (`deliver` in `workflows/runShell.ts`, proving a `'use step'` bundles + runs
 * across entrypoints), and that the bus dispatches on the thread's binding: a bound thread →
 * gateway; a detached (`subagent:`) inbox → append + wake, no gateway egress.
 */
describe('runJob (workflow integration — real Local World)', () => {
  let ctx: TestRuntimeCtx;
  afterEach(async () => {
    if (ctx) await teardownTestRuntime(ctx);
  });

  it('bound thread: delivers the final assistant text via the gateway', async () => {
    ctx = await setupTestRuntime();
    setTurnModel([{ type: 'text', text: 'done: built the thing' }]);

    const run = await start(runJob, [
      { threadId: 'imessage:owner', task: 'build the thing', ownerName: 'Devon' },
    ]);
    await run.returnValue;
    expect(await run.status).toBe('completed');

    expect(ctx.gateway.texts()).toEqual(['done: built the thing']);
  });

  it('detached inbox: appends to the inbox + wakes, with NO gateway egress', async () => {
    ctx = await setupTestRuntime();
    setTurnModel([{ type: 'text', text: 'report for my parent' }]);

    const run = await start(runJob, [
      { threadId: 'subagent:abc', task: 'do a subtask', ownerName: 'Devon' },
    ]);
    await run.returnValue;
    expect(await run.status).toBe('completed');

    expect(ctx.gateway.sendCount).toBe(0); // detached → never hits the gateway
    const steers = await ctx.store.unansweredSteers('subagent:abc', []);
    expect(steers.map((s) => s.text)).toContain('report for my parent');
    expect(ctx.wakeCalls).toContain('subagent:abc'); // run-supply woken to fold it
  });
});
