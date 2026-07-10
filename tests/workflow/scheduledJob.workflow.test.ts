import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { start } from 'workflow/api';
import { runScheduledJob } from '../../workflows/scheduledJob.js';
import { schedules, scheduleRuns } from '../../src/db/schema.js';
import {
  capturedPrompts,
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

  it('audience: a household run can deliberately fan out to a roster member (message is its only voice)', async () => {
    ctx = await setupTestRuntime({ family: [{ name: 'Kate', identities: ['+17193146820'] }] });
    const { runId } = await seedScheduleRun('silent');
    const kateThread = 'sendblue:owner:kate';
    await ctx.store.appendInbound(
      makeChannelEvent({ threadId: kateThread, senderId: '+17193146820', senderName: 'Kate', isOwner: false }),
    );
    setTurnModel([
      {
        type: 'tool-call',
        toolName: 'message',
        input: JSON.stringify({ recipient: 'Kate', text: 'Household heads-up: bins go out tonight' }),
      },
      { type: 'text', text: 'briefed the household' },
    ]);

    const run = await start(runScheduledJob, [
      {
        scheduleId: 's',
        runId,
        prompt: 'brief the household',
        ownerName: 'Devon',
        audience: { kind: 'household' },
      },
    ]);
    await run.returnValue;
    expect(await run.status).toBe('completed');

    // The deliberate fan-out reached Kate exactly once; the terminal result was recorded, not sent.
    const fanOuts = ctx.gateway.sent.filter(
      (s) => s.text === 'Household heads-up: bins go out tonight',
    );
    expect(fanOuts).toHaveLength(1);
    expect(fanOuts[0]?.threadId).toBe(kateThread);
    expect(ctx.gateway.sent.some((s) => s.text === 'briefed the household')).toBe(false);
  });

  it('audience: a delivering run can send_image to its own audience thread', async () => {
    ctx = await setupTestRuntime();
    const { runId } = await seedScheduleRun('user');
    setTurnModel([
      {
        type: 'tool-call',
        toolName: 'send_image',
        input: JSON.stringify({ pathOrUrl: '/tmp/chart.png', caption: 'your daily chart' }),
      },
      { type: 'text', text: 'Chart sent.' },
    ]);

    const run = await start(runScheduledJob, [
      {
        scheduleId: 's',
        runId,
        prompt: 'send the daily chart',
        ownerName: 'Devon',
        audience: { kind: 'thread', threadId: 'imessage:owner' },
      },
    ]);
    await run.returnValue;
    expect(await run.status).toBe('completed');

    const img = ctx.gateway.sent.find((s) => s.attachment);
    expect(img?.threadId).toBe('imessage:owner');
    expect(img?.attachment).toEqual({ pathOrUrl: '/tmp/chart.png' });
    expect(img?.text).toBe('your daily chart');
  });

  it('authority: a run endowed host grants can act on the host (bash) — the craft-tagging gap', async () => {
    ctx = await setupTestRuntime();
    const { runId } = await seedScheduleRun('user');
    setTurnModel([
      {
        type: 'tool-call',
        toolName: 'bash',
        input: JSON.stringify({ command: 'echo tagged-3-docs' }),
      },
      { type: 'text', text: 'Tagged 3 docs.' },
    ]);

    const run = await start(runScheduledJob, [
      {
        scheduleId: 's',
        runId,
        prompt: 'run the daily tagging job',
        ownerName: 'Devon',
        audience: { kind: 'thread', threadId: 'imessage:owner' },
        authority: ['file_read', 'memory_read', 'bash', 'file_write'],
      },
    ]);
    await run.returnValue;
    expect(await run.status).toBe('completed'); // the bash tool existed and the call succeeded

    expect(ctx.gateway.texts()).toEqual(['Tagged 3 docs.']);
  });

  it('dreaming shape (context-lifecycle): a silent run with the dream grants executes the sunny CLI over bash; idle outcome recorded', async () => {
    // The dreaming job is a PLAIN scheduled run — no dedicated workflow. This drives the
    // craft-style shape end-to-end: household/silent + authority ['memory_read',
    // 'memory_write', 'bash', 'file_read'], with bash actually spawning the repo CLI
    // (`npx tsx src/cli/index.ts dream`). The bare `dream` invocation deterministically
    // prints the model-actionable usage (it exits before any DB connect), proving the CLI
    // is reachable from a granted run; the idle path then records the run without sending.
    ctx = await setupTestRuntime();
    const { runId } = await seedScheduleRun('silent');
    setTurnModel([
      {
        type: 'tool-call',
        toolName: 'bash',
        input: JSON.stringify({
          command: 'cd /home/tivona/projects/sunny && npx tsx src/cli/index.ts dream',
          timeout_ms: 120_000,
        }),
      },
      { type: 'text', text: 'dream: idle' },
    ]);

    const run = await start(runScheduledJob, [
      {
        scheduleId: 's',
        runId,
        prompt: 'Dreaming: follow your dreaming skill.',
        ownerName: 'Devon',
        audience: { kind: 'household' },
        authority: ['memory_read', 'memory_write', 'bash', 'file_read'],
      },
    ]);
    await run.returnValue;
    expect(await run.status).toBe('completed');

    // The CLI actually ran: the second model step's prompt carries its usage output as the
    // bash tool result (captured from the mock — what the model really saw).
    const secondStep = capturedPrompts()[1];
    expect(secondStep, 'the bash step should have produced a second model step').toBeTruthy();
    expect(JSON.stringify(secondStep)).toContain('usage: sunny');

    // Idle path: nothing sent (silent household run), the run row records the outcome.
    expect(ctx.gateway.sendCount).toBe(0);
    const [row] = await ctx.db.db.select().from(scheduleRuns).where(eq(scheduleRuns.id, runId));
    expect(row?.status).toBe('completed');
    expect(row?.output).toBe('dream: idle');
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
