import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { start } from 'workflow/api';
import { runScheduledJob } from '../../workflows/scheduledJob.js';
import { schedules, scheduleRuns } from '../../src/db/schema.js';
import {
  setTurnModel,
  setupTestRuntime,
  teardownTestRuntime,
  type TestRuntimeCtx,
} from './harness.js';

/**
 * `runScheduledJob` against a real in-process WDK Local World (durable-subagents task 10.2).
 * The headline `silent` fix: a maintenance schedule (nightly memory consolidation) records its
 * result for inspection but sends NO proactive message — the 2am-text fix. A `user` schedule
 * still delivers.
 */
describe('runScheduledJob (workflow integration — real Local World)', () => {
  let ctx: TestRuntimeCtx;
  afterEach(async () => {
    if (ctx) await teardownTestRuntime(ctx);
  });

  async function seedScheduleRun(outputTarget: 'user' | 'silent'): Promise<{ runId: string }> {
    const [sched] = await ctx.db.db
      .insert(schedules)
      .values({
        kind: 'cron',
        spec: '0 3 * * *',
        prompt: 'consolidate memory',
        threadId: 'imessage:owner',
        timezone: 'America/Denver',
        outputTarget,
        active: true,
      })
      .returning();
    const [run] = await ctx.db.db
      .insert(scheduleRuns)
      .values({ scheduleId: sched!.id, status: 'running' })
      .returning();
    return { runId: run!.id };
  }

  it('silent: records the result but sends nothing (the 2am fix)', async () => {
    ctx = await setupTestRuntime();
    const { runId } = await seedScheduleRun('silent');
    setTurnModel([{ type: 'text', text: 'tidied 3 facts' }]);

    const run = await start(runScheduledJob, [
      {
        scheduleId: 's',
        runId,
        threadId: 'imessage:owner',
        prompt: 'consolidate memory',
        ownerName: 'Devon',
        outputTarget: 'silent',
      },
    ]);
    await run.returnValue;
    expect(await run.status).toBe('completed');

    expect(ctx.gateway.sendCount).toBe(0); // silent → no 2am text
    const [row] = await ctx.db.db
      .select()
      .from(scheduleRuns)
      .where(eq(scheduleRuns.id, runId));
    expect(row?.status).toBe('completed'); // result still recorded
    expect(row?.output).toBe('tidied 3 facts');
  });

  it('user: delivers the reply via the gateway', async () => {
    ctx = await setupTestRuntime();
    const { runId } = await seedScheduleRun('user');
    setTurnModel([{ type: 'text', text: 'your 9am reminder' }]);

    const run = await start(runScheduledJob, [
      {
        scheduleId: 's',
        runId,
        threadId: 'imessage:owner',
        prompt: 'remind me',
        ownerName: 'Devon',
        outputTarget: 'user',
      },
    ]);
    await run.returnValue;

    expect(ctx.gateway.texts()).toEqual(['your 9am reminder']);
  });
});
