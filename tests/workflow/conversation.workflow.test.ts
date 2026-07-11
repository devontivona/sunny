import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { start } from 'workflow/api';
import { runConversation } from '../../workflows/conversation.js';
import {
  capturedPrompts,
  replyOnce,
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

  it('answers an inbound: delivers the reply text, persists one turn, marks it processed', async () => {
    ctx = await setupTestRuntime();
    const event = makeChannelEvent({ text: 'hey sunny' });
    await ctx.store.appendInbound(event);
    setTurnModel(replyOnce('hey! what is up?'));

    const run = await start(runConversation, [{ threadId: event.threadId }]);
    await run.returnValue;
    expect(await run.status).toBe('completed');

    expect(ctx.gateway.texts()).toEqual(['hey! what is up?']); // delivered exactly once
    const window = await ctx.store.recentWindow(event.threadId);
    expect(window.filter((m) => m.role === 'assistant')).toHaveLength(1); // one persisted turn
    expect(await ctx.store.hasUnansweredInbound(event.threadId)).toBe(false); // marked processed
  });

  it('file tools (coding-agent-upgrade): write → edit → read round-trip through real durable steps', async () => {
    // Drives the REAL registered file_write/file_edit/file_read tools through the durable
    // turn's `'use step'` seam against the real filesystem — the end-to-end wiring check.
    ctx = await setupTestRuntime();
    const file = join(mkdtempSync(join(tmpdir(), 'sunny-wf-files-')), 'app.ts');
    const event = makeChannelEvent({ text: 'make me a file' });
    await ctx.store.appendInbound(event);
    setTurnModel([
      {
        type: 'tool-call',
        toolName: 'file_write',
        input: JSON.stringify({ path: file, content: 'const x = 1;\nconst y = 2;\n' }),
      },
      {
        type: 'tool-call',
        toolName: 'file_edit',
        input: JSON.stringify({
          path: file,
          old_string: 'const y = 2;',
          new_string: 'const y = 42;',
        }),
      },
      { type: 'tool-call', toolName: 'file_read', input: JSON.stringify({ path: file }) },
      { type: 'text', text: 'done — y is now 42' },
    ]);

    const run = await start(runConversation, [{ threadId: event.threadId }]);
    await run.returnValue;
    expect(await run.status).toBe('completed');

    expect(readFileSync(file, 'utf8')).toBe('const x = 1;\nconst y = 42;\n'); // the edit landed
    expect(ctx.gateway.texts()).toEqual(['done — y is now 42']);
  });

  it('persists ONLY this turn — never re-merges prior tool calls from the window (no dup tool_use ids)', async () => {
    // Regression for the thread-poisoning storm: the durable turn was persisted from
    // `result.messages` (the FULL conversation = input window + generated), so every prior
    // assistant turn already in the window got re-merged into the new row. That compounds each
    // turn and reintroduces earlier `tool_use` ids — Anthropic then rejects every later turn with
    // "`tool_use` ids must be unique", and the durable run retries forever. The turn must persist
    // ONLY its own generated content.
    ctx = await setupTestRuntime();

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
    // Live turn: a bash call (a real tool part with its own id), then the reply text.
    setTurnModel([
      { type: 'text', text: '' },
      { type: 'tool-call', toolName: 'bash', input: '{"command":"echo ctx"}' },
      { type: 'text', text: 'fresh reply' },
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
        (p) => p.type === 'text' && (p as any).text === 'fresh reply',
      ),
    )!;
    expect(toolIdsOf(freshTurn)).not.toContain('toolu_PRIOR_UNIQUE');

    const allToolIds = assistantTurns.flatMap(toolIdsOf);
    expect(allToolIds.filter((id) => id === 'toolu_PRIOR_UNIQUE')).toHaveLength(1);
    expect(new Set(allToolIds).size).toBe(allToolIds.length); // no duplicate tool_use ids anywhere
  });

  it('compacted thread: the prompt is summary-first + only post-watermark rows; marks only real ids (context-lifecycle)', async () => {
    ctx = await setupTestRuntime();
    const threadId = makeChannelEvent({}).threadId;

    // An older, ANSWERED exchange that the dream compacted away.
    const old = makeChannelEvent({ threadId, text: 'remind me about the tax filing' });
    await ctx.store.appendInbound(old);
    await ctx.store.markProcessedMany('imessage', [old.messageId]);
    await ctx.store.appendTurn(
      threadId,
      { id: 'old-turn', role: 'assistant', parts: [{ type: 'text', text: 'filed jointly in April' }] },
      'filed jointly in April',
    );
    // Compact at the assistant turn — the boundary tuple is copied in SQL from the row
    // (exactly what `sunny dream compact` does), so covered/replayed is precision-exact.
    const win = await ctx.store.recentWindow(threadId);
    const boundary = win.at(-1)!;
    expect(boundary.role).toBe('assistant');
    await ctx.db.db.execute(sql`
      INSERT INTO thread_compactions (thread_id, boundary_created_at, boundary_message_id, summary)
      SELECT thread_id, created_at, message_id, ${'Earlier: taxes discussed — filed jointly in April.'}
      FROM messages WHERE thread_id = ${threadId} AND message_id = ${boundary.messageId}
    `);

    // A fresh inbound after the watermark.
    const fresh = makeChannelEvent({ threadId, text: 'and when is the next estimated payment?' });
    await ctx.store.appendInbound(fresh);
    setTurnModel(replyOnce('September 15th'));

    const run = await start(runConversation, [{ threadId }]);
    await run.returnValue;
    expect(await run.status).toBe('completed');
    expect(ctx.gateway.texts()).toEqual(['September 15th']);

    // What the model actually SAW (captured from the mock): the first conversation message
    // is the summary block (data-framed), the compacted rows are absent, the fresh row present.
    const prompt = capturedPrompts()[0]!;
    const flat = JSON.stringify(prompt);
    const conversation = prompt.filter((m) => m.role !== 'system');
    expect(JSON.stringify(conversation[0])).toContain('COMPACTED CONVERSATION HISTORY');
    expect(flat).toContain('Earlier: taxes discussed — filed jointly in April.');
    expect(flat).toContain('and when is the next estimated payment?');
    expect(flat).not.toContain('remind me about the tax filing'); // covered rows do not replay

    // markAnswered marked ONLY the real fresh id — the summary block carries no message ids.
    expect(await ctx.store.hasUnansweredInbound(threadId)).toBe(false);
    expect((await ctx.store.findUnprocessedInbound()).map((e) => e.messageId)).toEqual([]);
  });

  it('is a no-op when there is no unanswered inbound', async () => {
    ctx = await setupTestRuntime();
    const event = makeChannelEvent({ text: 'already answered' });
    await ctx.store.appendInbound(event);
    await ctx.store.markProcessedMany('imessage', [event.messageId]);
    setTurnModel(replyOnce('should not send'));

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
    // replies and stops. We inject `b` between start and the run draining.
    setTurnModel([
      { type: 'tool-call', toolName: 'bash', input: '{"command":"echo planning"}' },
      { type: 'text', text: 'warm it is' },
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

  it('wait tool: a trailing multipart part arriving DURING the wait folds into the same turn', async () => {
    ctx = await setupTestRuntime();
    const a = makeChannelEvent({ text: 'Can you put this on my calendar?' });
    await ctx.store.appendInbound(a);
    // Model: sees the forward reference, calls wait (2s), then replies once with the full
    // picture. The link part is injected WHILE the wait step sleeps — genuinely mid-turn —
    // and must fold into the step after the wait (multipart-coalesce, model-level half).
    setTurnModel([
      { type: 'tool-call', toolName: 'wait', input: '{"seconds":2}' },
      { type: 'text', text: 'On the calendar 🎋' },
    ]);

    const run = await start(runConversation, [{ threadId: a.threadId }]);
    // Inject the trailing part while the turn is inside its wait step.
    await new Promise((r) => setTimeout(r, 500));
    const b = makeChannelEvent({ text: 'https://example.com/savor-japan' });
    await ctx.store.appendInbound(b);
    await run.returnValue;
    expect(await run.status).toBe('completed');

    expect(ctx.gateway.texts()).toEqual(['On the calendar 🎋']); // one reply, no "what do you mean?"
    // BOTH parts answered by this single turn (window + the steer folded after the wait).
    expect(await ctx.store.hasUnansweredInbound(a.threadId)).toBe(false);
  });

  it('family DM: routes a person-fact to people:<id>, never the owner USER.md (multiplayer-family)', async () => {
    const KATE = '+17193146820';
    ctx = await setupTestRuntime({
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
        input: JSON.stringify({
          file: 'people:17193146820',
          action: 'add',
          content: '- Vegetarian',
        }),
      },
      { type: 'text', text: 'got it!' },
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
      { type: 'text', text: 'ok' },
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
      { type: 'text', text: 'ok' },
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
      owner: { name: 'Devon', identities: ['+15551230000'] },
      family: [{ name: 'Kate', identities: [KATE] }],
    });
    // Kate has an existing DM thread (so the recipient resolves to it).
    const kateThread = 'sendblue:owner:kate';
    await ctx.store.appendInbound(
      makeChannelEvent({
        threadId: kateThread,
        senderId: KATE,
        senderName: 'Kate',
        isOwner: false,
      }),
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
      { type: 'text', text: 'Sent to Kate 👍' },
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
      owner: { name: 'Devon', identities: ['+15551230000'] },
      family: [{ name: 'Kate', identities: [KATE] }],
    });
    const kateThread = 'sendblue:owner:kate';
    await ctx.store.appendInbound(
      makeChannelEvent({
        threadId: kateThread,
        senderId: KATE,
        senderName: 'Kate',
        isOwner: false,
      }),
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
      { type: 'text', text: 'Sent! 🦁' },
    ]);

    const run = await start(runConversation, [{ threadId: devon.threadId }]);
    await run.returnValue;
    expect(await run.status).toBe('completed');

    // The relayed message + its image attachment landed on KATE's thread.
    const toKate = ctx.gateway.sent.find((s) => s.threadId === kateThread);
    expect(toKate?.text).toBe('Devon wanted you to see this 🦁');
    expect(toKate?.attachment).toEqual({ pathOrUrl: '/home/tivona/work/leo_lion.jpg', required: true });
    expect(toKate?.persist).toBe(true);
  });

  it('message (person): refuses a non-roster recipient (roster-only)', async () => {
    ctx = await setupTestRuntime({
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
      { type: 'text', text: 'I can only text family.' },
    ]);

    const run = await start(runConversation, [{ threadId: devon.threadId }]);
    await run.returnValue;
    expect(await run.status).toBe('completed');

    // Nothing was sent to the stranger's number (no outbound other than Devon's own thread).
    const offRoster = ctx.gateway.sent.filter((s) => s.threadId !== devon.threadId);
    expect(offRoster).toHaveLength(0);
  });

  it('text mode: delivers the final text as ONE message (blank lines preserved), persists delivered=text', async () => {
    ctx = await setupTestRuntime();
    const event = makeChannelEvent({ text: 'two tips please' });
    await ctx.store.appendInbound(event);
    setTurnModel([{ type: 'text', text: 'tip one: sleep early\n\ntip two: less coffee' }]);

    const run = await start(runConversation, [{ threadId: event.threadId }]);
    await run.returnValue;
    expect(await run.status).toBe('completed');

    // One message, paragraphs intact (bubble-splitting removed 2026-07-05 — too noisy).
    expect(ctx.gateway.texts()).toEqual(['tip one: sleep early\n\ntip two: less coffee']);
    const window = await ctx.store.recentWindow(event.threadId);
    const turn = window.find((m) => m.role === 'assistant')!;
    const meta = (turn.payload as UIMessage).metadata as {
      delivered?: string;
      recovered?: boolean;
    };
    expect(meta.delivered).toBe('text');
    expect(meta.recovered).toBe(false);
    expect(await ctx.store.hasUnansweredInbound(event.threadId)).toBe(false);
  });

  it('text mode: a <no-reply/> sentinel reply means nothing is sent (delivered=silence)', async () => {
    // Silence-by-sentinel (2026-07-05 redesign): the model chooses silence by making the
    // sentinel its ENTIRE reply — WITH the trained end-with-text prior, not against it.
    // The raw sentinel still persists in the row (self-reinforcing precedent).
    ctx = await setupTestRuntime();
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
      payload.parts.some(
        (p) => p.type === 'text' && (p as { text?: string }).text === '<no-reply/>',
      ),
    ).toBe(true);
  });

  it('text mode: real content alongside a stray sentinel is delivered with the token stripped', async () => {
    // The safety property the terminal-stay_silent design lacked: a genuine reply is
    // never swallowed just because a silence signal also appeared.
    ctx = await setupTestRuntime();
    const event = makeChannelEvent({ text: 'so what should I do?' });
    await ctx.store.appendInbound(event);
    setTurnModel([{ type: 'text', text: '<no-reply/> actually — take the earlier flight.' }]);

    const run = await start(runConversation, [{ threadId: event.threadId }]);
    await run.returnValue;
    expect(await run.status).toBe('completed');

    expect(ctx.gateway.texts()).toEqual(['actually — take the earlier flight.']);
    const window = await ctx.store.recentWindow(event.threadId);
    const meta = (window.find((m) => m.role === 'assistant')!.payload as UIMessage).metadata as {
      delivered?: string;
    };
    expect(meta.delivered).toBe('text');
  });

  it('text mode: empty final with interim narration takes the recovery backstop (recovered=true)', async () => {
    ctx = await setupTestRuntime(
      {},
      {
        recoverOverride: (scratch: string) => `composed from notes: ${scratch.slice(0, 20)}`,
        translateOverride: () => '', // keep the cadence step from reaching a live model
      },
    );
    const event = makeChannelEvent({ text: 'check the weather' });
    await ctx.store.appendInbound(event);
    // Narration + a tool call, then the turn ENDS on a tool step (no final text).
    setTurnModel([
      {
        type: 'tool-call',
        toolName: 'bash',
        input: '{"command":"echo sunny"}',
        text: 'checking forecast',
      },
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
        (p) =>
          p.type === 'text' && (p as { text?: string }).text?.startsWith('composed from notes'),
      ),
    ).toBe(true);
  });

  it('text mode: translator relays narration on the first non-terminal step, persists data-translator', async () => {
    const composed: string[] = [];
    ctx = await setupTestRuntime(
      { translatorEveryNSteps: 3 },
      {
        translateOverride: (interim: string) => {
          composed.push(interim);
          return `update: ${interim.split('\n')[0]}`;
        },
      },
    );
    const event = makeChannelEvent({ text: 'plan my trip' });
    await ctx.store.appendInbound(event);
    // Step 0: narration + tool call (non-terminal). Step 1: the final reply text.
    setTurnModel([
      {
        type: 'tool-call',
        toolName: 'bash',
        input: '{"command":"echo x"}',
        text: 'looking at flights first',
      },
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
    ctx = await setupTestRuntime(
      {},
      {
        translateOverride: () => '',
      },
    );
    const event = makeChannelEvent({ text: 'quick check' });
    await ctx.store.appendInbound(event);
    setTurnModel([
      {
        type: 'tool-call',
        toolName: 'bash',
        input: '{"command":"echo x"}',
        text: 'internal bookkeeping',
      },
      { type: 'text', text: 'all set: nothing to change' },
    ]);

    const run = await start(runConversation, [{ threadId: event.threadId }]);
    await run.returnValue;

    expect(ctx.gateway.texts()).toEqual(['all set: nothing to change']);
    const window = await ctx.store.recentWindow(event.threadId);
    const payload = window.find((m) => m.role === 'assistant')!.payload as UIMessage;
    expect(payload.parts.filter((p) => p.type === 'data-translator')).toHaveLength(0);
  });

  it('translator: notes ACCUMULATE across declined beats; step context reaches the composer', async () => {
    // 2026-07-05 production finding: the cursor advanced even on a declined update, so
    // every beat saw a ~3-step window and Haiku's "quick work" rule matched all of them —
    // 9/9 declines on a 15-step turn. Now: decline → the next beat sees EVERYTHING since
    // the last SENT update, plus the step counters the prompt needs.
    const beats: Array<{ interim: string; step?: number; since?: number }> = [];
    ctx = await setupTestRuntime(
      { translatorEveryNSteps: 2 },
      {
        translateOverride: (interim: string, _r: string[], step?: number, since?: number) => {
          beats.push({ interim, step, since });
          return beats.length < 2 ? '' : `update after ${since} silent steps`; // decline first beat
        },
      },
    );
    const event = makeChannelEvent({ text: 'long research task' });
    await ctx.store.appendInbound(event);
    setTurnModel([
      { type: 'tool-call', toolName: 'bash', input: '{"command":"echo a"}', text: 'n0' },
      { type: 'tool-call', toolName: 'bash', input: '{"command":"echo b"}', text: 'n1' },
      { type: 'tool-call', toolName: 'bash', input: '{"command":"echo c"}', text: 'n2' },
      { type: 'text', text: 'final answer' },
    ]);

    const run = await start(runConversation, [{ threadId: event.threadId }]);
    await run.returnValue;
    expect(await run.status).toBe('completed');

    // Beat 1 (step 1): sees step 0's notes, declines. Beat 2 (step 3): sees the
    // ACCUMULATED notes (n0 still there — the cursor did not advance on decline).
    expect(beats).toHaveLength(2);
    expect(beats[0]).toMatchObject({ step: 1, since: 1 });
    expect(beats[0]!.interim).toContain('n0');
    expect(beats[1]).toMatchObject({ step: 3, since: 3 });
    for (const n of ['n0', 'n1', 'n2']) expect(beats[1]!.interim).toContain(n);

    expect(ctx.gateway.texts()).toEqual(['update after 3 silent steps', 'final answer']);
  });

  it('text mode: translator cadence — fires at steps 1 and 1+N, not in between', async () => {
    const firedAt: string[] = [];
    ctx = await setupTestRuntime(
      { translatorEveryNSteps: 2 },
      {
        translateOverride: (interim: string) => {
          firedAt.push(interim);
          return `u${firedAt.length}`;
        },
      },
    );
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

    // Persisted CHRONOLOGY (2026-07-05): each update's data-translator part sits at its
    // true position — u1 (triggered at step 1) before step 1's narration, u2 (step 3)
    // before step 3's — never lumped after the tool calls.
    const window = await ctx.store.recentWindow(event.threadId);
    const payload = window.find((m) => m.role === 'assistant')!.payload as UIMessage;
    const seq = payload.parts
      .map((p) =>
        p.type === 'data-translator'
          ? `U:${(p as { data?: { text?: string } }).data?.text}`
          : p.type === 'text' && (p as { text?: string }).text?.trim()
            ? `T:${(p as { text?: string }).text}`
            : null,
      )
      .filter(Boolean);
    expect(seq).toEqual(['T:n0', 'U:u1', 'T:n1', 'T:n2', 'U:u2', 'T:n3', 'T:done — final answer']);
  });

  it('text mode: delivers the reply EXACTLY ONCE when a post-send step fails and the workflow replays', async () => {
    ctx = await setupTestRuntime();
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
    expect(ctx.gateway.texts()).toEqual(['bubble one\n\nbubble two']); // exactly once
  });

  it('R6: a message that lands after the prompt snapshot is not marked answered without being seen', async () => {
    // loadPending must derive its mark-answered id set from the SAME window snapshot the prompt
    // was built from. If a second inbound lands in the gap (here: right after loadPending reads
    // the window), it is neither in the prompt nor folded by steering — so it must NOT be stamped
    // answered. It stays unprocessed for a later turn instead of being silently dropped.
    ctx = await setupTestRuntime();
    const a = makeChannelEvent({ text: 'first question' });
    await ctx.store.appendInbound(a);
    setTurnModel(replyOnce('answering the first'));

    const b = makeChannelEvent({ text: 'a second, later question' });
    let calls = 0;
    const realRW = ctx.store.recentWindow.bind(ctx.store);
    vi.spyOn(ctx.store, 'recentWindow').mockImplementation(async (threadId: string) => {
      const win = await realRW(threadId);
      calls += 1;
      // Inject B AFTER loadPending's window read (the 2nd recentWindow call: setupTurn is the 1st).
      if (calls === 2) await ctx.store.appendInbound(b);
      return win;
    });

    const run = await start(runConversation, [{ threadId: a.threadId }]);
    await run.returnValue;
    expect(await run.status).toBe('completed');

    expect(ctx.gateway.texts()).toEqual(['answering the first']);
    const pending = (await ctx.store.findUnprocessedInbound()).map((e) => e.messageId);
    expect(pending).toContain(b.messageId); // left for the next turn — NOT silently dropped
    expect(pending).not.toContain(a.messageId); // A (in the prompt) was answered
  });

  it('R9b: a failing recovery backstop does not mark the inbound answered with no reply', async () => {
    // Abnormal turn end → fallback_text → backstop. When the backstop THROWS (or composes
    // nothing), the turn delivered nothing: the inbound must stay unanswered for a re-run, never
    // be silently stamped answered-with-no-reply.
    ctx = await setupTestRuntime(
      {},
      {
        recoverOverride: () => {
          throw new Error('backstop model unavailable');
        },
        translateOverride: () => '',
      },
    );
    const event = makeChannelEvent({ text: 'check the weather' });
    await ctx.store.appendInbound(event);
    setTurnModel([
      { type: 'tool-call', toolName: 'bash', input: '{"command":"echo x"}', text: 'checking' },
      { type: 'text', text: '' },
    ]);

    const run = await start(runConversation, [{ threadId: event.threadId }]);
    await run.returnValue;
    expect(await run.status).toBe('completed'); // the throw is caught, not fatal

    expect(ctx.gateway.sendCount).toBe(0); // backstop produced nothing → nothing sent
    expect(await ctx.store.hasUnansweredInbound(event.threadId)).toBe(true); // left for recovery
  });

  it('R9c: a turn that produces no deliverable output does not silently consume the inbound', async () => {
    // The model returns empty text and stops (no reply, no sentinel, no tool work). That is not a
    // deliberate silence — nothing was delivered — so the inbound must not be marked answered.
    ctx = await setupTestRuntime();
    const event = makeChannelEvent({ text: 'hello?' });
    await ctx.store.appendInbound(event);
    setTurnModel([{ type: 'text', text: '' }]);

    const run = await start(runConversation, [{ threadId: event.threadId }]);
    await run.returnValue;
    expect(await run.status).toBe('completed');

    expect(ctx.gateway.sendCount).toBe(0);
    expect(await ctx.store.hasUnansweredInbound(event.threadId)).toBe(true); // not silently consumed
  });

  it('text mode: send_image rides the send step; send_message is not offered', async () => {
    // translateOverride: the step-1 cadence trigger now always has notes (the tool-call
    // log), so without the stub it would reach a live model.
    ctx = await setupTestRuntime({}, { translateOverride: () => '' });
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
    expect(img?.attachment).toEqual({ pathOrUrl: '/home/tivona/work/chart.png', required: true });
    expect(img?.text).toBe('this week');
    expect(ctx.gateway.texts()).toContain('chart sent — red line is spend');
  });
});
