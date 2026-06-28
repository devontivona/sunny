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
 * `runJob` against a real in-process WDK Local World (durable-subagents tasks 1.4 / 2.x).
 * Verifies the background-job profile reports through the SHARED `emitStep` (proving a
 * `'use step'` in `workflows/runShell.ts` bundles + runs across workflow entrypoints), and
 * that `output_target` routes: `user` delivers via the gateway, `silent` sends nothing.
 */
describe('runJob (workflow integration — real Local World)', () => {
  let ctx: TestRuntimeCtx;
  afterEach(async () => {
    if (ctx) await teardownTestRuntime(ctx);
  });

  it('user target: emits the final assistant text via the gateway', async () => {
    ctx = await setupTestRuntime();
    setTurnModel([{ type: 'text', text: 'done: built the thing' }]);

    const run = await start(runJob, [
      { threadId: 'imessage:owner', task: 'build the thing', ownerName: 'Devon' },
    ]);
    await run.returnValue;
    expect(await run.status).toBe('completed');

    expect(ctx.gateway.texts()).toEqual(['done: built the thing']);
  });

  it('silent target: records nothing outward (no 2am text)', async () => {
    ctx = await setupTestRuntime();
    setTurnModel([{ type: 'text', text: 'tidied 3 facts' }]);

    const run = await start(runJob, [
      {
        threadId: 'imessage:owner',
        task: 'consolidate memory',
        ownerName: 'Devon',
        outputTarget: 'silent',
      },
    ]);
    await run.returnValue;
    expect(await run.status).toBe('completed');

    expect(ctx.gateway.sendCount).toBe(0); // silent → nothing delivered
  });
});
