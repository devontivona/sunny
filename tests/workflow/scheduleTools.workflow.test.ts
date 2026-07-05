import { afterEach, describe, expect, it } from 'vitest';
import { start } from 'workflow/api';
import { runConversation } from '../../workflows/conversation.js';
import { listSchedules } from '../../src/scheduler/index.js';
import {
  setTurnModel,
  setupTestRuntime,
  teardownTestRuntime,
  type TestRuntimeCtx,
} from './harness.js';
import { makeChannelEvent } from '../factories.js';

/**
 * Self-scheduling on a durable conversational turn — run-audiences **Phase 1a** regression fix.
 *
 * The durable-main-loop migration (`9d0654b`) rebuilt the turn as `workflows/conversation.ts`
 * but never re-registered `createScheduleTools`, so Sunny lost the ability to schedule itself
 * (it told a family member "I can't run my own timer in the background"). These drive the REAL
 * `runConversation` workflow against the in-process WDK Local World with a scripted model that
 * calls `schedule_create`, and assert a persisted schedule row + a delivered confirmation.
 *
 * The tool is gated on `trustedDm` (any DM — owner OR family), NOT owner-only, so a family
 * member can schedule for themselves; the second test proves the non-owner path.
 */
describe('self-scheduling on a trusted-DM turn (run-audiences Phase 1a)', () => {
  let ctx: TestRuntimeCtx;
  afterEach(async () => {
    if (ctx) await teardownTestRuntime(ctx);
  });

  it('a trusted-DM turn creates a schedule via schedule_create and confirms it', async () => {
    ctx = await setupTestRuntime({ deliveryMode: 'tool' });
    const event = makeChannelEvent({ text: 'remind me to check on Leo every morning at 8' });
    await ctx.store.appendInbound(event);
    setTurnModel([
      {
        type: 'tool-call',
        toolName: 'schedule_create',
        input: JSON.stringify({
          kind: 'cron',
          spec: '0 8 * * *',
          prompt: 'Check whether Leo has been fed and remind if not.',
          label: 'leo-check',
        }),
      },
      {
        type: 'tool-call',
        toolName: 'send_message',
        input: JSON.stringify({ text: "Done — I'll check every morning at 8." }),
      },
      { type: 'text', text: '' },
    ]);

    const run = await start(runConversation, [{ threadId: event.threadId }]);
    await run.returnValue;
    expect(await run.status).toBe('completed');

    const rows = await listSchedules(ctx.db.db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'cron',
      spec: '0 8 * * *',
      label: 'leo-check',
      threadId: event.threadId, // delivered back to the thread it was created in
      active: true,
    });
    expect(ctx.gateway.texts()).toContain("Done — I'll check every morning at 8.");
  });

  it('a non-owner family member can also schedule (gate is trusted-DM, not owner-only)', async () => {
    const KATE = '+17195550000';
    ctx = await setupTestRuntime({ deliveryMode: 'tool', family: [{ name: 'Kate', identities: [KATE] }] });
    const event = makeChannelEvent({
      threadId: 'sendblue:owner:kate',
      senderId: KATE,
      senderName: 'Kate',
      isOwner: false,
      text: 'remind me at 3pm to call the pediatrician',
    });
    await ctx.store.appendInbound(event);
    setTurnModel([
      {
        type: 'tool-call',
        toolName: 'schedule_create',
        input: JSON.stringify({
          kind: 'once',
          spec: '2027-01-01T15:00:00.000Z',
          prompt: 'Remind Kate to call the pediatrician.',
        }),
      },
      {
        type: 'tool-call',
        toolName: 'send_message',
        input: JSON.stringify({ text: 'Got it — reminder set.' }),
      },
      { type: 'text', text: '' },
    ]);

    const run = await start(runConversation, [{ threadId: event.threadId }]);
    await run.returnValue;
    expect(await run.status).toBe('completed');

    const rows = await listSchedules(ctx.db.db);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.threadId).toBe('sendblue:owner:kate'); // fires back to Kate's thread, not the owner's
    expect(ctx.gateway.texts()).toContain('Got it — reminder set.');
  });

  it('cancel_run on a trusted-DM turn cancels an existing schedule', async () => {
    ctx = await setupTestRuntime({ deliveryMode: 'tool' });
    // Seed a schedule directly, then drive a turn that cancels it by id.
    const { createSchedule } = await import('../../src/scheduler/index.js');
    const seeded = await createSchedule(ctx.db.db, {
      kind: 'interval',
      spec: '2h',
      prompt: 'ping',
      threadId: makeChannelEvent().threadId,
      timezone: 'America/New_York',
    });
    const event = makeChannelEvent({ text: 'cancel that reminder' });
    await ctx.store.appendInbound(event);
    setTurnModel([
      {
        type: 'tool-call',
        toolName: 'cancel_run',
        input: JSON.stringify({ id: seeded.id }),
      },
      { type: 'tool-call', toolName: 'send_message', input: JSON.stringify({ text: 'Cancelled.' }) },
      { type: 'text', text: '' },
    ]);

    const run = await start(runConversation, [{ threadId: event.threadId }]);
    await run.returnValue;

    expect(await listSchedules(ctx.db.db)).toHaveLength(0);
  });

  it('cross-person (#4): the owner can schedule FOR a family member via `for`', async () => {
    ctx = await setupTestRuntime({
    deliveryMode: 'tool',
      owner: { name: 'Devon', identities: ['+15551230000'] },
      family: [{ name: 'Kate', identities: ['+17193146820'] }],
    });
    const devon = makeChannelEvent({ text: 'remind Kate at 3pm to call the pediatrician' });
    await ctx.store.appendInbound(devon);
    setTurnModel([
      {
        type: 'tool-call',
        toolName: 'schedule_create',
        input: JSON.stringify({
          kind: 'once',
          spec: '2027-01-01T15:00:00.000Z',
          prompt: 'Remind about the pediatrician',
          for: 'Kate',
        }),
      },
      { type: 'tool-call', toolName: 'send_message', input: JSON.stringify({ text: "Set for Kate." }) },
      { type: 'text', text: '' },
    ]);

    const run = await start(runConversation, [{ threadId: devon.threadId }]);
    await run.returnValue;
    expect(await run.status).toBe('completed');

    const rows = await listSchedules(ctx.db.db);
    expect(rows).toHaveLength(1);
    // The schedule is stored as a person: audience for Kate — the fired run will act for + deliver
    // to Kate, NOT Devon's thread.
    expect(rows[0]?.audience).toBe('person:Kate');
  });

  it('cross-person: scheduling for a NON-roster name is refused', async () => {
    ctx = await setupTestRuntime({ deliveryMode: 'tool', owner: { name: 'Devon', identities: ['+15551230000'] } });
    const devon = makeChannelEvent({ text: 'remind Stranger tomorrow' });
    await ctx.store.appendInbound(devon);
    setTurnModel([
      {
        type: 'tool-call',
        toolName: 'schedule_create',
        input: JSON.stringify({ kind: 'once', spec: '2027-01-01T09:00:00.000Z', prompt: 'x', for: 'Stranger' }),
      },
      { type: 'tool-call', toolName: 'send_message', input: JSON.stringify({ text: 'ok' }) },
      { type: 'text', text: '' },
    ]);

    const run = await start(runConversation, [{ threadId: devon.threadId }]);
    await run.returnValue;
    expect(await listSchedules(ctx.db.db)).toHaveLength(0); // refused → nothing created
  });

  it('list_runs shows the owner all schedules', async () => {
    ctx = await setupTestRuntime({ deliveryMode: 'tool' });
    const { createSchedule } = await import('../../src/scheduler/index.js');
    await createSchedule(ctx.db.db, {
      kind: 'cron',
      spec: '0 9 * * *',
      prompt: 'morning briefing',
      threadId: makeChannelEvent().threadId,
      timezone: 'America/New_York',
      label: 'briefing',
    });
    const event = makeChannelEvent({ text: 'what have you got scheduled?' });
    await ctx.store.appendInbound(event);
    setTurnModel([
      { type: 'tool-call', toolName: 'list_runs', input: JSON.stringify({}) },
      { type: 'tool-call', toolName: 'send_message', input: JSON.stringify({ text: 'Here they are.' }) },
      { type: 'text', text: '' },
    ]);

    const run = await start(runConversation, [{ threadId: event.threadId }]);
    await run.returnValue;
    expect(await run.status).toBe('completed');
    // The turn completed with the list_runs tool available + invoked (no error → schedule still there).
    expect(await listSchedules(ctx.db.db)).toHaveLength(1);
  });
});
