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
import { makeChannelEvent } from '../factories.js';

/**
 * `runScheduledJob` against a real in-process WDK Local World (durable-subagents task 10.2;
 * run-audiences D-RA2/D-RA15). A `household` audience (nightly consolidation) records its result
 * but sends NOTHING (structurally silent — the 2am-text fix). A `thread` audience delivers through
 * the bus to that thread — the OWNER's, or a FAMILY member's (family-correct delivery), not a
 * hardcoded owner thread.
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
        prompt: 'consolidate memory',
        ownerName: 'Devon',
        audience: { kind: 'household' },
      },
    ]);
    await run.returnValue;
    expect(await run.status).toBe('completed');

    expect(ctx.gateway.sendCount).toBe(0); // household + no messaging grant → no 2am text
    const [row] = await ctx.db.db
      .select()
      .from(scheduleRuns)
      .where(eq(scheduleRuns.id, runId));
    expect(row?.status).toBe('completed'); // result still recorded
    expect(row?.output).toBe('tidied 3 facts');
  });

  it('thread audience: delivers the reply via the gateway to that thread', async () => {
    ctx = await setupTestRuntime();
    const { runId } = await seedScheduleRun('user');
    setTurnModel([{ type: 'text', text: 'your 9am reminder' }]);

    const run = await start(runScheduledJob, [
      {
        scheduleId: 's',
        runId,
        prompt: 'remind me',
        ownerName: 'Devon',
        audience: { kind: 'thread', threadId: 'imessage:owner' },
      },
    ]);
    await run.returnValue;

    expect(ctx.gateway.texts()).toEqual(['your 9am reminder']);
  });

  it('family-correct: a schedule fired for a family member delivers to THEIR thread, not the owner', async () => {
    ctx = await setupTestRuntime({ family: [{ name: 'Kate', identities: ['+17193146820'] }] });
    const { runId } = await seedScheduleRun('user');
    const kateThread = 'sendblue:owner:kate';
    setTurnModel([{ type: 'text', text: 'Leo is due for a feed 🍼' }]);

    const run = await start(runScheduledJob, [
      {
        scheduleId: 's',
        runId,
        prompt: 'check on Leo',
        ownerName: 'Devon',
        audience: { kind: 'thread', threadId: kateThread },
      },
    ]);
    await run.returnValue;

    const sent = ctx.gateway.sent.find((s) => s.text === 'Leo is due for a feed 🍼');
    expect(sent?.threadId).toBe(kateThread); // delivered to Kate's thread, not imessage:owner
  });

  it('proactive fan-out (D-RA10): a delivering scheduled run can message a roster member via the bus', async () => {
    ctx = await setupTestRuntime({ family: [{ name: 'Kate', identities: ['+17193146820'] }] });
    const { runId } = await seedScheduleRun('user');
    const kateThread = 'sendblue:owner:kate';
    // Give Kate an existing DM so the roster resolution finds her bound thread.
    await ctx.store.appendInbound(
      makeChannelEvent({ threadId: kateThread, senderId: '+17193146820', senderName: 'Kate', isOwner: false }),
    );
    setTurnModel([
      {
        type: 'tool-call',
        toolName: 'message',
        input: JSON.stringify({ recipient: 'Kate', text: 'Reminder: Leo feed 🍼' }),
      },
      { type: 'text', text: '' },
    ]);

    const run = await start(runScheduledJob, [
      {
        scheduleId: 's',
        runId,
        prompt: 'remind Kate about the feed',
        ownerName: 'Devon',
        audience: { kind: 'thread', threadId: 'imessage:owner' },
      },
    ]);
    await run.returnValue;
    expect(await run.status).toBe('completed');

    const toKate = ctx.gateway.sent.find((s) => s.threadId === kateThread);
    expect(toKate?.text).toBe('Reminder: Leo feed 🍼'); // proactively reached Kate via the message tool
    expect(toKate?.persist).toBe(true);
  });
});
