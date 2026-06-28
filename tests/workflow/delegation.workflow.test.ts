import { afterEach, describe, expect, it, vi } from 'vitest';
import { getLinkByChildThread } from '../../src/agent/delegation.js';
import {
  setTurnModel,
  setupTestRuntime,
  teardownTestRuntime,
  type TestRuntimeCtx,
} from './harness.js';

/**
 * End-to-end delegation against a real WDK Local World (durable-subagents tasks 5/6/7): the
 * supervisor seam → a real `runSubagent` child run → its report landing on the parent's inbox →
 * the parent's run-supply being woken. This is the whole child→parent loop, minus only the
 * conversation model deciding to call `delegate_task` (the tool→step→`spawnChild` wrapper is
 * typechecked; the shared mock-model seam can't drive parent + child in one run).
 */
describe('delegation (workflow integration — real Local World)', () => {
  let ctx: TestRuntimeCtx;
  afterEach(async () => {
    if (ctx) await teardownTestRuntime(ctx);
  });

  const OWNER = 'imessage:owner';

  it('spawn → child runs → reports to the parent inbox → wakes the parent', async () => {
    ctx = await setupTestRuntime();
    // The mock drives the CHILD (the only run here): produce a final result, no tools.
    setTurnModel([{ type: 'text', text: 'found it: 42' }]);

    const res = await ctx.spawnChild({
      parentThreadId: OWNER,
      task: 'find the answer to the question',
      depth: 1,
      label: 'researcher',
    });
    expect('childThreadId' in res).toBe(true);
    if (!('childThreadId' in res)) return;

    // The child run completes in the background; wait for it to close its link (D-DS7).
    await vi.waitFor(
      async () => {
        const link = await getLinkByChildThread(ctx.db.db, res.childThreadId);
        expect(link?.status).toBe('done');
      },
      { timeout: 20_000, interval: 200 },
    );

    // Its report landed on the PARENT's inbox as an unanswered inbound, attributed to the label.
    const window = await ctx.store.recentWindow(OWNER);
    const report = window.find((m) => m.role === 'user' && m.text.includes('found it: 42'));
    expect(report?.senderName).toBe('researcher');
    expect(await ctx.store.hasUnansweredInbound(OWNER)).toBe(true);
    // The child's report woke the parent's run-supply (router.wake in production).
    expect(ctx.wakeCalls).toContain(OWNER);
  });

  it('parent → child steer lands on the child inbox (folds via loadSteers in-flight)', async () => {
    ctx = await setupTestRuntime();
    await ctx.steerChild('subagent:in-flight', 'also check the archive');
    const steers = await ctx.store.unansweredSteers('subagent:in-flight', []);
    expect(steers.map((s) => s.text)).toContain('also check the archive');
    expect(steers[0]?.senderName).toBe('parent');
  });
});
