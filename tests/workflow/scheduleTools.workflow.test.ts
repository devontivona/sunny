import { afterEach, describe, expect, it } from 'vitest';
import { start } from 'workflow/api';
import { runConversation } from '../../workflows/conversation.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { listSchedules, standingSchedulesDir } from '../../src/scheduler/index.js';
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
 * calls `schedule_create`, and assert the created schedule + a delivered confirmation.
 * Recurring (cron) schedules become STANDING FILES in state/schedules/ (portability D14);
 * one-off reminders stay DB rows.
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
    ctx = await setupTestRuntime();
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
      { type: 'text', text: "Done — I'll check every morning at 8." },
    ]);

    const run = await start(runConversation, [{ threadId: event.threadId }]);
    await run.returnValue;
    expect(await run.status).toBe('completed');

    // Recurring = STANDING (portability D14): a state-repo file, not a DB row.
    expect(await listSchedules(ctx.db.db)).toHaveLength(0);
    const standing = ctx.fileSchedules.list();
    expect(standing).toHaveLength(1);
    expect(standing[0]).toMatchObject({
      fileClass: 'standing',
      kind: 'cron',
      spec: '0 8 * * *',
      label: 'leo-check',
      active: true,
    });
    expect(
      existsSync(join(standingSchedulesDir(ctx.config.runtimeDir), 'leo-check.md')),
    ).toBe(true);
    expect(ctx.gateway.texts()).toContain("Done — I'll check every morning at 8.");
  });

  it('a non-owner family member can also schedule (gate is trusted-DM, not owner-only)', async () => {
    const KATE = '+17195550000';
    ctx = await setupTestRuntime({ family: [{ name: 'Kate', identities: [KATE] }] });
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
      { type: 'text', text: 'Got it — reminder set.' },
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
    ctx = await setupTestRuntime();
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
      { type: 'text', text: 'Cancelled.' },
    ]);

    const run = await start(runConversation, [{ threadId: event.threadId }]);
    await run.returnValue;

    expect(await listSchedules(ctx.db.db)).toHaveLength(0);
  });

  it('cross-person (#4): the owner can schedule FOR a family member via `for`', async () => {
    ctx = await setupTestRuntime({
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
      { type: 'text', text: "Set for Kate." },
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
    ctx = await setupTestRuntime({ owner: { name: 'Devon', identities: ['+15551230000'] } });
    const devon = makeChannelEvent({ text: 'remind Stranger tomorrow' });
    await ctx.store.appendInbound(devon);
    setTurnModel([
      {
        type: 'tool-call',
        toolName: 'schedule_create',
        input: JSON.stringify({ kind: 'once', spec: '2027-01-01T09:00:00.000Z', prompt: 'x', for: 'Stranger' }),
      },
      { type: 'text', text: 'ok' },
    ]);

    const run = await start(runConversation, [{ threadId: devon.threadId }]);
    await run.returnValue;
    expect(await listSchedules(ctx.db.db)).toHaveLength(0); // refused → nothing created
  });

  it('authority: an owner-DM schedule defaults to the host preset, stored as grants on the row', async () => {
    ctx = await setupTestRuntime();
    const event = makeChannelEvent({ text: 'tag my craft docs every morning' });
    await ctx.store.appendInbound(event);
    setTurnModel([
      {
        type: 'tool-call',
        toolName: 'schedule_create',
        input: JSON.stringify({
          kind: 'cron',
          spec: '0 5 * * *',
          prompt: 'Run the daily craft tagging job per skill:craft.',
          label: 'craft-tagging',
          // no toolset → host, the default (one vocabulary with delegate_task)
        }),
      },
      { type: 'text', text: 'Scheduled with host access.' },
    ]);

    const run = await start(runConversation, [{ threadId: event.threadId }]);
    await run.returnValue;
    expect(await run.status).toBe('completed');

    const standing = ctx.fileSchedules.list();
    expect(standing).toHaveLength(1);
    // Owner DM → the full host bundle, registries included.
    expect(standing[0]?.authority).toEqual([
      'file_read',
      'memory_read',
      'runs_read',
      'bash',
      'file_write',
      'memory_write',
      'credentials',
      'mcp',
    ]);
  });

  it('authority: a family DM host schedule is attenuated — no owner-facing registries', async () => {
    const KATE = '+17195550000';
    ctx = await setupTestRuntime({ family: [{ name: 'Kate', identities: [KATE] }] });
    const event = makeChannelEvent({
      threadId: 'sendblue:owner:kate',
      senderId: KATE,
      senderName: 'Kate',
      isOwner: false,
      text: 'set up a nightly job for me',
    });
    await ctx.store.appendInbound(event);
    setTurnModel([
      {
        type: 'tool-call',
        toolName: 'schedule_create',
        input: JSON.stringify({
          kind: 'cron',
          spec: '0 2 * * *',
          prompt: 'nightly tidy-up',
          toolset: 'host',
        }),
      },
      { type: 'text', text: 'Set.' },
    ]);

    const run = await start(runConversation, [{ threadId: event.threadId }]);
    await run.returnValue;
    expect(await run.status).toBe('completed');

    const standing = ctx.fileSchedules.list();
    expect(standing).toHaveLength(1);
    // Host preset ∩ family-DM authority: everything except credentials/mcp (owner-DM only).
    expect(standing[0]?.authority).toContain('bash');
    expect(standing[0]?.authority).not.toContain('credentials');
    expect(standing[0]?.authority).not.toContain('mcp');
    // A family member's standing schedule captures its subject as an explicit audience —
    // the file carries no machine thread id, so this keeps it delivering to Kate.
    expect(standing[0]?.audience).toBe('person:Kate');
  });

  it('authority: readonly preset stores only the read-side grants', async () => {
    ctx = await setupTestRuntime();
    const event = makeChannelEvent({ text: 'digest that sketchy newsletter every morning' });
    await ctx.store.appendInbound(event);
    setTurnModel([
      {
        type: 'tool-call',
        toolName: 'schedule_create',
        input: JSON.stringify({
          kind: 'cron',
          spec: '0 7 * * *',
          prompt: 'Read and summarize the newsletter file.',
          toolset: 'readonly',
        }),
      },
      { type: 'text', text: 'Scheduled read-only.' },
    ]);

    const run = await start(runConversation, [{ threadId: event.threadId }]);
    await run.returnValue;
    expect(await run.status).toBe('completed');

    const standing = ctx.fileSchedules.list();
    expect(standing[0]?.authority).toEqual(['file_read', 'memory_read', 'runs_read']);
  });

  it('list_runs shows the owner all schedules', async () => {
    ctx = await setupTestRuntime();
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
      { type: 'text', text: 'Here they are.' },
    ]);

    const run = await start(runConversation, [{ threadId: event.threadId }]);
    await run.returnValue;
    expect(await run.status).toBe('completed');
    // The turn completed with the list_runs tool available + invoked (no error → schedule still there).
    expect(await listSchedules(ctx.db.db)).toHaveLength(1);
  });
});
