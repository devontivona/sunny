import { afterEach, describe, expect, it, vi } from 'vitest';
import { start } from 'workflow/api';
import { runConversation } from '../../workflows/conversation.js';
import {
  sendOnce,
  setTurnModel,
  setupTestRuntime,
  teardownTestRuntime,
  type TestRuntimeCtx,
} from './harness.js';
import { makeChannelEvent } from '../factories.js';

/**
 * End-to-end `runConversation` against a real in-process WDK Local World (durable-main-loop,
 * the @workflow/vitest best-practice path). Unlike the modeled step tests, these `start()` the
 * actual workflow — exercising the real agent loop, `prepareStep` folding, delivery
 * classification, persistence, and the `processedAt` watermark.
 */
describe('runConversation (workflow integration — real Local World)', () => {
  let ctx: TestRuntimeCtx;
  afterEach(async () => {
    if (ctx) await teardownTestRuntime(ctx);
  });

  it('answers an inbound: delivers via send_message, persists one turn, marks it processed', async () => {
    ctx = await setupTestRuntime();
    const event = makeChannelEvent({ text: 'hey sunny' });
    await ctx.store.appendInbound(event);
    setTurnModel(sendOnce('hey! what is up?'));

    const run = await start(runConversation, [{ threadId: event.threadId }]);
    await run.returnValue;
    expect(await run.status).toBe('completed');

    expect(ctx.gateway.texts()).toEqual(['hey! what is up?']); // delivered exactly once
    const window = await ctx.store.recentWindow(event.threadId);
    expect(window.filter((m) => m.role === 'assistant')).toHaveLength(1); // one persisted turn
    expect(await ctx.store.hasUnansweredInbound(event.threadId)).toBe(false); // marked processed
  });

  it('is a no-op when there is no unanswered inbound', async () => {
    ctx = await setupTestRuntime();
    const event = makeChannelEvent({ text: 'already answered' });
    await ctx.store.appendInbound(event);
    await ctx.store.markProcessedMany('imessage', [event.messageId]);
    setTurnModel(sendOnce('should not send'));

    const run = await start(runConversation, [{ threadId: event.threadId }]);
    await run.returnValue;
    expect(await run.status).toBe('completed');

    expect(ctx.gateway.sendCount).toBe(0); // nothing unanswered → no turn, no send
  });

  it('folds a message that arrives mid-turn into the same turn (double-text steering)', async () => {
    ctx = await setupTestRuntime();
    const a = makeChannelEvent({ text: 'plan a trip' });
    await ctx.store.appendInbound(a);
    // A second message lands AFTER the window is read (step 0) but before the model's next
    // step — `prepareStep`'s loadSteers must surface it and fold it into this same turn.
    const b = makeChannelEvent({ text: 'somewhere warm' });
    // Model: step 0 makes a tool call (so there's a step 1 where the steer can fold), then
    // delivers once and stops. We inject `b` between start and the run draining.
    setTurnModel([
      { type: 'tool-call', toolName: 'stay_silent', input: '{}' },
      {
        type: 'tool-call',
        toolName: 'send_message',
        input: JSON.stringify({ text: 'warm it is' }),
      },
      { type: 'text', text: '' },
    ]);

    // Persist `b` so loadSteers (run at step 1) finds it. (In production the gateway persists
    // on arrival; here we persist before starting so it's reliably present for the fold.)
    await ctx.store.appendInbound(b);

    const run = await start(runConversation, [{ threadId: a.threadId }]);
    await run.returnValue;

    expect(ctx.gateway.texts()).toEqual(['warm it is']);
    // BOTH messages are marked answered by this one turn (window + folded steer).
    expect(await ctx.store.hasUnansweredInbound(a.threadId)).toBe(false);
  });

  it('delivers EXACTLY ONCE when a post-send step fails and the workflow replays', async () => {
    ctx = await setupTestRuntime();
    const event = makeChannelEvent({ text: 'crash test' });
    await ctx.store.appendInbound(event);
    setTurnModel(sendOnce('delivered once'));

    // Make the FIRST `markAnsweredForThread` throw, forcing the mark step to retry. On retry the
    // workflow replays — the already-completed send step is memoized and must NOT re-run, so
    // the message is delivered exactly once even though the turn ran past the send twice.
    const real = ctx.store.markAnsweredForThread.bind(ctx.store);
    let failed = false;
    vi.spyOn(ctx.store, 'markAnsweredForThread').mockImplementation(async (threadId, ids) => {
      if (!failed) {
        failed = true;
        throw new Error('boom: simulated crash after delivery');
      }
      return real(threadId, ids);
    });

    const run = await start(runConversation, [{ threadId: event.threadId }]);
    await run.returnValue;
    expect(await run.status).toBe('completed');

    expect(failed).toBe(true); // the failure path was exercised
    expect(ctx.gateway.sendCount).toBe(1); // delivered exactly once despite the replay
    expect(await ctx.store.hasUnansweredInbound(event.threadId)).toBe(false); // eventually marked
  });
});
