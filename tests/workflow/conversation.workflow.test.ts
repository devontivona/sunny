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
import type { UIMessage } from 'ai';

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
    ctx = await setupTestRuntime({ deliveryMode: 'tool' });
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

  it('persists ONLY this turn — never re-merges prior tool calls from the window (no dup tool_use ids)', async () => {
    // Regression for the thread-poisoning storm: the durable turn was persisted from
    // `result.messages` (the FULL conversation = input window + generated), so every prior
    // assistant turn already in the window got re-merged into the new row. That compounds each
    // turn and reintroduces earlier `tool_use` ids — Anthropic then rejects every later turn with
    // "`tool_use` ids must be unique", and the durable run retries forever. The turn must persist
    // ONLY its own generated content.
    ctx = await setupTestRuntime({ deliveryMode: 'tool' });

    // A prior, already-answered turn whose payload carries a distinctive tool-call id.
    const first = makeChannelEvent({ text: 'earlier question' });
    await ctx.store.appendInbound(first);
    await ctx.store.markProcessedMany('imessage', [first.messageId]);
    const priorTurn: UIMessage = {
      id: 'prior',
      role: 'assistant',
      parts: [
        {
          type: 'tool-bash',
          toolCallId: 'toolu_PRIOR_UNIQUE',
          state: 'output-available',
          input: { command: 'echo hi' },
          output: 'hi',
        } as UIMessage['parts'][number],
        {
          type: 'tool-send_message',
          toolCallId: 'send-prior',
          state: 'output-available',
          input: { text: 'earlier reply' },
          output: 'delivered',
        } as UIMessage['parts'][number],
      ],
    };
    await ctx.store.appendTurn(first.threadId, priorTurn, 'earlier reply');

    // A new, unanswered inbound; the model just sends once. The mock indexes its response by the
    // count of assistant messages already in the prompt, and the seeded prior turn is one such
    // message — so the first step here lands at index 1. Pad index 0 so the send fires on step 1.
    const second = makeChannelEvent({ text: 'new question' });
    await ctx.store.appendInbound(second);
    setTurnModel([
      { type: 'text', text: '' },
      {
        type: 'tool-call',
        toolName: 'send_message',
        input: JSON.stringify({ text: 'fresh reply' }),
      },
      { type: 'text', text: '' },
    ]);

    const run = await start(runConversation, [{ threadId: second.threadId }]);
    await run.returnValue;
    expect(await run.status).toBe('completed');

    const window = await ctx.store.recentWindow(second.threadId);
    const assistantTurns = window.filter((m) => m.role === 'assistant');
    expect(assistantTurns).toHaveLength(2); // prior + this turn, each persisted once

    const toolIdsOf = (m: (typeof assistantTurns)[number]) =>
      ((m.payload as UIMessage | null)?.parts ?? [])
        .filter((p) => p.type.startsWith('tool-'))
        .map((p) => (p as { toolCallId: string }).toolCallId);

    // The NEW turn (the one that delivered 'fresh reply') must contain only its own tool call —
    // never the prior turn's id. And `toolu_PRIOR_UNIQUE` must appear in exactly ONE row total.
    const freshTurn = assistantTurns.find((m) =>
      ((m.payload as UIMessage).parts ?? []).some(
        (p) => p.type === 'tool-send_message' && (p as any).input?.text === 'fresh reply',
      ),
    )!;
    expect(toolIdsOf(freshTurn)).not.toContain('toolu_PRIOR_UNIQUE');

    const allToolIds = assistantTurns.flatMap(toolIdsOf);
    expect(allToolIds.filter((id) => id === 'toolu_PRIOR_UNIQUE')).toHaveLength(1);
    expect(new Set(allToolIds).size).toBe(allToolIds.length); // no duplicate tool_use ids anywhere
  });


  it('is a no-op when there is no unanswered inbound', async () => {
    ctx = await setupTestRuntime({ deliveryMode: 'tool' });
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
    ctx = await setupTestRuntime({ deliveryMode: 'tool' });
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

  it('family DM: routes a person-fact to people:<id>, never the owner USER.md (multiplayer-family)', async () => {
    const KATE = '+17193146820';
    ctx = await setupTestRuntime({
      deliveryMode: 'tool',
      owner: { name: 'Devon', identities: ['+15551230000'] },
      family: [{ name: 'Kate', identities: [KATE] }],
    });
    // A family member's DM (distinct thread, non-owner, trusted).
    const event = makeChannelEvent({
      threadId: 'sendblue:owner:kate',
      senderId: KATE,
      senderName: 'Kate',
      isOwner: false,
    });
    await ctx.store.appendInbound(event);
    // The model records a durable fact about Kate, then replies.
    setTurnModel([
      {
        type: 'tool-call',
        toolName: 'memory_write',
        input: JSON.stringify({ file: 'people:17193146820', action: 'add', content: '- Vegetarian' }),
      },
      { type: 'tool-call', toolName: 'send_message', input: JSON.stringify({ text: 'got it!' }) },
      { type: 'text', text: '' },
    ]);

    const run = await start(runConversation, [{ threadId: event.threadId }]);
    await run.returnValue;
    expect(await run.status).toBe('completed');

    const { readFileSync, existsSync } = await import('node:fs');
    const { memoryPaths } = await import('../../src/memory/index.js');
    const paths = memoryPaths(ctx.config.runtimeDir);
    // Kate's profile doc was auto-created on first contact and carries the fact.
    expect(readFileSync(paths.person('17193146820'), 'utf8')).toContain('- Vegetarian');
    // The owner's USER.md never received it.
    const user = existsSync(paths.USER) ? readFileSync(paths.USER, 'utf8') : '';
    expect(user).not.toContain('Vegetarian');
    expect(ctx.gateway.texts()).toEqual(['got it!']);
  });

  it('family DM: cannot edit the owner USER.md (owner-only carve-out)', async () => {
    const KATE = '+17193146820';
    ctx = await setupTestRuntime({
      deliveryMode: 'tool',
      owner: { name: 'Devon', identities: ['+15551230000'] },
      family: [{ name: 'Kate', identities: [KATE] }],
    });
    const event = makeChannelEvent({
      threadId: 'sendblue:owner:kate2',
      senderId: KATE,
      senderName: 'Kate',
      isOwner: false,
    });
    await ctx.store.appendInbound(event);
    // The model attempts to write the owner's USER.md from a family member's turn → blocked.
    setTurnModel([
      {
        type: 'tool-call',
        toolName: 'memory_write',
        input: JSON.stringify({ file: 'USER', action: 'add', content: '- injected secret' }),
      },
      { type: 'tool-call', toolName: 'send_message', input: JSON.stringify({ text: 'ok' }) },
      { type: 'text', text: '' },
    ]);

    const run = await start(runConversation, [{ threadId: event.threadId }]);
    await run.returnValue;
    expect(await run.status).toBe('completed');

    const { readFileSync } = await import('node:fs');
    const { memoryPaths } = await import('../../src/memory/index.js');
    const user = readFileSync(memoryPaths(ctx.config.runtimeDir).USER, 'utf8');
    expect(user).not.toContain('injected secret');
  });

  it('family DM: cannot edit SUNNY.md (owner-only operating notes)', async () => {
    const KATE = '+17193146820';
    ctx = await setupTestRuntime({
      deliveryMode: 'tool',
      owner: { name: 'Devon', identities: ['+15551230000'] },
      family: [{ name: 'Kate', identities: [KATE] }],
    });
    const event = makeChannelEvent({
      threadId: 'sendblue:owner:kate3',
      senderId: KATE,
      senderName: 'Kate',
      isOwner: false,
    });
    await ctx.store.appendInbound(event);
    // A family member's turn must not be able to reprogram Sunny's operating notes.
    setTurnModel([
      {
        type: 'tool-call',
        toolName: 'memory_write',
        input: JSON.stringify({ file: 'SUNNY', action: 'add', content: '- reprogrammed conduct' }),
      },
      { type: 'tool-call', toolName: 'send_message', input: JSON.stringify({ text: 'ok' }) },
      { type: 'text', text: '' },
    ]);

    const run = await start(runConversation, [{ threadId: event.threadId }]);
    await run.returnValue;
    expect(await run.status).toBe('completed');

    const { readFileSync } = await import('node:fs');
    const { memoryPaths } = await import('../../src/memory/index.js');
    const sunny = readFileSync(memoryPaths(ctx.config.runtimeDir).SUNNY, 'utf8');
    expect(sunny).not.toContain('reprogrammed conduct');
  });

  it('message (person): relays to another roster member on their thread, confirms on the current one', async () => {
    const KATE = '+17193146820';
    ctx = await setupTestRuntime({
      deliveryMode: 'tool',
      owner: { name: 'Devon', identities: ['+15551230000'] },
      family: [{ name: 'Kate', identities: [KATE] }],
    });
    // Kate has an existing DM thread (so the recipient resolves to it).
    const kateThread = 'sendblue:owner:kate';
    await ctx.store.appendInbound(
      makeChannelEvent({ threadId: kateThread, senderId: KATE, senderName: 'Kate', isOwner: false }),
    );
    // Devon, in his own DM, asks Sunny to text Kate.
    const devon = makeChannelEvent({
      threadId: 'sendblue:owner:devon',
      senderId: '+15551230000',
      senderName: 'Devon',
      isOwner: true,
      text: 'text Kate that I say hi',
    });
    await ctx.store.appendInbound(devon);
    setTurnModel([
      {
        type: 'tool-call',
        toolName: 'message',
        input: JSON.stringify({ recipient: 'Kate', text: 'Devon says hi!' }),
      },
      { type: 'tool-call', toolName: 'send_message', input: JSON.stringify({ text: 'Sent to Kate 👍' }) },
      { type: 'text', text: '' },
    ]);

    const run = await start(runConversation, [{ threadId: devon.threadId }]);
    await run.returnValue;
    expect(await run.status).toBe('completed');

    // The relayed message went to KATE's thread...
    const toKate = ctx.gateway.sent.find((s) => s.threadId === kateThread);
    expect(toKate?.text).toBe('Devon says hi!');
    expect(toKate?.persist).toBe(true); // recorded in Kate's history
    // ...and the confirmation went back to DEVON's thread.
    const toDevon = ctx.gateway.sent.find((s) => s.threadId === devon.threadId);
    expect(toDevon?.text).toBe('Sent to Kate 👍');
  });

  it('message (person): relays an image attachment to the recipient thread', async () => {
    const KATE = '+17193146820';
    ctx = await setupTestRuntime({
      deliveryMode: 'tool',
      owner: { name: 'Devon', identities: ['+15551230000'] },
      family: [{ name: 'Kate', identities: [KATE] }],
    });
    const kateThread = 'sendblue:owner:kate';
    await ctx.store.appendInbound(
      makeChannelEvent({ threadId: kateThread, senderId: KATE, senderName: 'Kate', isOwner: false }),
    );
    const devon = makeChannelEvent({
      threadId: 'sendblue:owner:devon',
      senderId: '+15551230000',
      senderName: 'Devon',
      isOwner: true,
      text: 'send Kate the lion pic',
    });
    await ctx.store.appendInbound(devon);
    setTurnModel([
      {
        type: 'tool-call',
        toolName: 'message',
        input: JSON.stringify({
          recipient: 'Kate',
          text: 'Devon wanted you to see this 🦁',
          image: '/home/tivona/work/leo_lion.jpg',
        }),
      },
      { type: 'tool-call', toolName: 'send_message', input: JSON.stringify({ text: 'Sent! 🦁' }) },
      { type: 'text', text: '' },
    ]);

    const run = await start(runConversation, [{ threadId: devon.threadId }]);
    await run.returnValue;
    expect(await run.status).toBe('completed');

    // The relayed message + its image attachment landed on KATE's thread.
    const toKate = ctx.gateway.sent.find((s) => s.threadId === kateThread);
    expect(toKate?.text).toBe('Devon wanted you to see this 🦁');
    expect(toKate?.attachment).toEqual({ pathOrUrl: '/home/tivona/work/leo_lion.jpg' });
    expect(toKate?.persist).toBe(true);
  });

  it('message (person): refuses a non-roster recipient (roster-only)', async () => {
    ctx = await setupTestRuntime({
      deliveryMode: 'tool',
      owner: { name: 'Devon', identities: ['+15551230000'] },
      family: [{ name: 'Kate', identities: ['+17193146820'] }],
    });
    const devon = makeChannelEvent({
      threadId: 'sendblue:owner:devon2',
      senderId: '+15551230000',
      senderName: 'Devon',
      isOwner: true,
    });
    await ctx.store.appendInbound(devon);
    setTurnModel([
      {
        type: 'tool-call',
        toolName: 'message',
        input: JSON.stringify({ recipient: '+15559998888', text: 'hi stranger' }),
      },
      { type: 'tool-call', toolName: 'send_message', input: JSON.stringify({ text: 'I can only text family.' }) },
      { type: 'text', text: '' },
    ]);

    const run = await start(runConversation, [{ threadId: devon.threadId }]);
    await run.returnValue;
    expect(await run.status).toBe('completed');

    // Nothing was sent to the stranger's number (no outbound other than Devon's own thread).
    const offRoster = ctx.gateway.sent.filter((s) => s.threadId !== devon.threadId);
    expect(offRoster).toHaveLength(0);
  });

  it('text mode: delivers the final text as blank-line bubbles, persists delivered=text', async () => {
    ctx = await setupTestRuntime({ deliveryMode: 'text' });
    const event = makeChannelEvent({ text: 'two tips please' });
    await ctx.store.appendInbound(event);
    setTurnModel([{ type: 'text', text: 'tip one: sleep early\n\ntip two: less coffee' }]);

    const run = await start(runConversation, [{ threadId: event.threadId }]);
    await run.returnValue;
    expect(await run.status).toBe('completed');

    expect(ctx.gateway.texts()).toEqual(['tip one: sleep early', 'tip two: less coffee']);
    const window = await ctx.store.recentWindow(event.threadId);
    const turn = window.find((m) => m.role === 'assistant')!;
    const meta = (turn.payload as UIMessage).metadata as { delivered?: string; recovered?: boolean };
    expect(meta.delivered).toBe('text');
    expect(meta.recovered).toBe(false);
    expect(await ctx.store.hasUnansweredInbound(event.threadId)).toBe(false);
  });

  it('text mode: a <no-reply/> sentinel reply means nothing is sent (delivered=silence)', async () => {
    // Silence-by-sentinel (2026-07-05 redesign): the model chooses silence by making the
    // sentinel its ENTIRE reply — WITH the trained end-with-text prior, not against it.
    // The raw sentinel still persists in the row (self-reinforcing precedent).
    ctx = await setupTestRuntime({ deliveryMode: 'text' });
    const event = makeChannelEvent({ text: '👍' });
    await ctx.store.appendInbound(event);
    setTurnModel([{ type: 'text', text: '<no-reply/>' }]);

    const run = await start(runConversation, [{ threadId: event.threadId }]);
    await run.returnValue;
    expect(await run.status).toBe('completed');

    expect(ctx.gateway.sendCount).toBe(0);
    const window = await ctx.store.recentWindow(event.threadId);
    const payload = window.find((m) => m.role === 'assistant')!.payload as UIMessage;
    expect((payload.metadata as { delivered?: string }).delivered).toBe('silence');
    // The sentinel persists verbatim in the row's text part.
    expect(
      payload.parts.some((p) => p.type === 'text' && (p as { text?: string }).text === '<no-reply/>'),
    ).toBe(true);
  });

  it('text mode: real content alongside a stray sentinel is delivered with the token stripped', async () => {
    // The safety property the terminal-stay_silent design lacked: a genuine reply is
    // never swallowed just because a silence signal also appeared.
    ctx = await setupTestRuntime({ deliveryMode: 'text' });
    const event = makeChannelEvent({ text: 'so what should I do?' });
    await ctx.store.appendInbound(event);
    setTurnModel([{ type: 'text', text: '<no-reply/> actually — take the earlier flight.' }]);

    const run = await start(runConversation, [{ threadId: event.threadId }]);
    await run.returnValue;
    expect(await run.status).toBe('completed');

    expect(ctx.gateway.texts()).toEqual(['actually — take the earlier flight.']);
    const window = await ctx.store.recentWindow(event.threadId);
    const meta = (window.find((m) => m.role === 'assistant')!.payload as UIMessage)
      .metadata as { delivered?: string };
    expect(meta.delivered).toBe('text');
  });

  it('text mode: empty final with interim narration takes the recovery backstop (recovered=true)', async () => {
    ctx = await setupTestRuntime({ deliveryMode: 'text' }, {
      recoverOverride: (scratch: string) => `composed from notes: ${scratch.slice(0, 20)}`,
      translateOverride: () => '', // keep the cadence step from reaching a live model
    });
    const event = makeChannelEvent({ text: 'check the weather' });
    await ctx.store.appendInbound(event);
    // Narration + a tool call, then the turn ENDS on a tool step (no final text).
    setTurnModel([
      { type: 'tool-call', toolName: 'bash', input: '{"command":"echo sunny"}', text: 'checking forecast' },
      { type: 'text', text: '' },
    ]);

    const run = await start(runConversation, [{ threadId: event.threadId }]);
    await run.returnValue;
    expect(await run.status).toBe('completed');

    expect(ctx.gateway.texts()).toEqual(['composed from notes: checking forecast']);
    const window = await ctx.store.recentWindow(event.threadId);
    const payload = window.find((m) => m.role === 'assistant')!.payload as UIMessage;
    const meta = payload.metadata as { delivered?: string; recovered?: boolean };
    expect(meta.delivered).toBe('text');
    expect(meta.recovered).toBe(true);
    // The composed reply persists as a PLAIN TEXT part (never a synthetic tool part).
    const types = payload.parts.map((p) => p.type);
    expect(types).not.toContain('tool-send_message');
    expect(
      payload.parts.some(
        (p) => p.type === 'text' && (p as { text?: string }).text?.startsWith('composed from notes'),
      ),
    ).toBe(true);
  });

  it('text mode: translator relays narration on the first non-terminal step, persists data-translator', async () => {
    const composed: string[] = [];
    ctx = await setupTestRuntime({ deliveryMode: 'text', translatorEveryNSteps: 3 }, {
      translateOverride: (interim: string) => {
        composed.push(interim);
        return `update: ${interim.split('\n')[0]}`;
      },
    });
    const event = makeChannelEvent({ text: 'plan my trip' });
    await ctx.store.appendInbound(event);
    // Step 0: narration + tool call (non-terminal). Step 1: the final reply text.
    setTurnModel([
      { type: 'tool-call', toolName: 'bash', input: '{"command":"echo x"}', text: 'looking at flights first' },
      { type: 'text', text: 'booked research done — options coming up' },
    ]);

    const run = await start(runConversation, [{ threadId: event.threadId }]);
    await run.returnValue;
    expect(await run.status).toBe('completed');

    // The translator fired exactly once (step 1), fed step 0's narration + tool-call log
    // (tool lines matter: with thinking on, narration text is usually absent — measured
    // zero across a full grid — so tool calls are the only progress signal); the update
    // was delivered BEFORE the final reply.
    expect(composed).toEqual(['looking at flights first\n[ran bash: echo x]']);
    expect(ctx.gateway.texts()).toEqual([
      'update: looking at flights first',
      'booked research done — options coming up',
    ]);
    const window = await ctx.store.recentWindow(event.threadId);
    const payload = window.find((m) => m.role === 'assistant')!.payload as UIMessage;
    const trParts = payload.parts.filter((p) => p.type === 'data-translator');
    expect(trParts).toHaveLength(1);
    expect((trParts[0] as { data?: { text?: string; step?: number } }).data).toEqual({
      text: 'update: looking at flights first',
      step: 1,
    });
    // Interleave: the update sits before the final reply text in the persisted row.
    const types = payload.parts.map((p) => p.type);
    expect(types.indexOf('data-translator')).toBeLessThan(types.lastIndexOf('text'));
  });

  it('text mode: a declined update (translator silence) relays nothing and persists no part', async () => {
    ctx = await setupTestRuntime({ deliveryMode: 'text' }, {
      translateOverride: () => '',
    });
    const event = makeChannelEvent({ text: 'quick check' });
    await ctx.store.appendInbound(event);
    setTurnModel([
      { type: 'tool-call', toolName: 'bash', input: '{"command":"echo x"}', text: 'internal bookkeeping' },
      { type: 'text', text: 'all set: nothing to change' },
    ]);

    const run = await start(runConversation, [{ threadId: event.threadId }]);
    await run.returnValue;

    expect(ctx.gateway.texts()).toEqual(['all set: nothing to change']);
    const window = await ctx.store.recentWindow(event.threadId);
    const payload = window.find((m) => m.role === 'assistant')!.payload as UIMessage;
    expect(payload.parts.filter((p) => p.type === 'data-translator')).toHaveLength(0);
  });

  it('text mode: translator cadence — fires at steps 1 and 1+N, not in between', async () => {
    const firedAt: string[] = [];
    ctx = await setupTestRuntime({ deliveryMode: 'text', translatorEveryNSteps: 2 }, {
      translateOverride: (interim: string) => {
        firedAt.push(interim);
        return `u${firedAt.length}`;
      },
    });
    const event = makeChannelEvent({ text: 'long task' });
    await ctx.store.appendInbound(event);
    // Steps 0-3 are tool calls with narration; step 4 is the final reply. With N=2 the
    // trigger fires at steps 1 and 3 (and would at 5): step1 sees step 0's notes, step3
    // sees steps 1-2's. Notes = narration text + the [ran tool] log line per step.
    setTurnModel([
      { type: 'tool-call', toolName: 'bash', input: '{"command":"echo a"}', text: 'n0' },
      { type: 'tool-call', toolName: 'bash', input: '{"command":"echo b"}', text: 'n1' },
      { type: 'tool-call', toolName: 'bash', input: '{"command":"echo c"}', text: 'n2' },
      { type: 'tool-call', toolName: 'bash', input: '{"command":"echo d"}', text: 'n3' },
      { type: 'text', text: 'done — final answer' },
    ]);

    const run = await start(runConversation, [{ threadId: event.threadId }]);
    await run.returnValue;
    expect(await run.status).toBe('completed');

    expect(firedAt).toEqual([
      'n0\n[ran bash: echo a]',
      'n1\n[ran bash: echo b]\nn2\n[ran bash: echo c]',
    ]);
    expect(ctx.gateway.texts()).toEqual(['u1', 'u2', 'done — final answer']);
  });

  it('text mode: delivers bubbles EXACTLY ONCE when a post-send step fails and the workflow replays', async () => {
    ctx = await setupTestRuntime({ deliveryMode: 'text' });
    const event = makeChannelEvent({ text: 'crash test' });
    await ctx.store.appendInbound(event);
    setTurnModel([{ type: 'text', text: 'bubble one\n\nbubble two' }]);

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

    expect(failed).toBe(true);
    expect(ctx.gateway.texts()).toEqual(['bubble one', 'bubble two']); // exactly once each
  });

  it('text mode: send_image rides the send step; send_message is not offered', async () => {
    // translateOverride: the step-1 cadence trigger now always has notes (the tool-call
    // log), so without the stub it would reach a live model.
    ctx = await setupTestRuntime({ deliveryMode: 'text' }, { translateOverride: () => '' });
    const event = makeChannelEvent({ text: 'send me the chart' });
    await ctx.store.appendInbound(event);
    setTurnModel([
      {
        type: 'tool-call',
        toolName: 'send_image',
        input: JSON.stringify({ pathOrUrl: '/home/tivona/work/chart.png', caption: 'this week' }),
      },
      { type: 'text', text: 'chart sent — red line is spend' },
    ]);

    const run = await start(runConversation, [{ threadId: event.threadId }]);
    await run.returnValue;
    expect(await run.status).toBe('completed');

    const img = ctx.gateway.sent.find((s) => s.attachment);
    expect(img?.attachment).toEqual({ pathOrUrl: '/home/tivona/work/chart.png' });
    expect(img?.text).toBe('this week');
    expect(ctx.gateway.texts()).toContain('chart sent — red line is spend');
  });


  it('delivers EXACTLY ONCE when a post-send step fails and the workflow replays', async () => {
    ctx = await setupTestRuntime({ deliveryMode: 'tool' });
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
