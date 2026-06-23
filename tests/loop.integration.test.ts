import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SteerHandle } from '../src/agent/dispatcher.js';
import type { ChannelEvent } from '../src/gateway/types.js';
import { createTestDb, type TestDb } from './db.js';
import { createTestRuntime, type TestRuntime } from './harness.js';
import { makeChannelEvent } from './factories.js';
import {
  modelThatOnlyScratches,
  modelThatSends,
  modelThatThrows,
  recoveryText,
  scriptModel,
} from './fakes/model.js';

const NO_STEER: SteerHandle = { drain: () => [] };

/**
 * Agent loop end-to-end (task 5.5): the REAL loop driven by the mock model + fake
 * gateway against PGlite. We seed the inbound user message (the gateway's job in
 * production), then run the turn directly and assert on the captured outbound,
 * the `delivered` classification, and the persisted D-MG9 turn row.
 */
describe('agent loop end-to-end', () => {
  let tdb: TestDb;

  beforeEach(async () => {
    tdb = await createTestDb();
  });
  afterEach(async () => {
    // Let the owner-DM fire-and-forget consolidation seed settle before close.
    await new Promise((r) => setTimeout(r, 25));
    await tdb.teardown();
  });

  async function runOnce(rt: TestRuntime, ev: ChannelEvent) {
    await rt.store.appendInbound(ev);
    await rt.runTurn(ev, NO_STEER);
  }

  /** The assistant turn row persisted for a thread (the newest assistant row). */
  function lastTurn(rt: TestRuntime, threadId: string) {
    return rt.store.recentWindow(threadId);
  }

  it('scripted send_message → outbound captured, delivered=send_message, D-MG9 row', async () => {
    const rt = createTestRuntime({ db: tdb.db, model: modelThatSends('here you go') });
    const ev = makeChannelEvent({ text: 'help me with X' });
    await runOnce(rt, ev);

    expect(rt.gateway.texts()).toEqual(['here you go']);
    expect(rt.gateway.sent[0]?.persist).toBe(false); // loop persists the whole turn itself

    const win = await lastTurn(rt, ev.threadId);
    const turn = win.find((m) => m.role === 'assistant');
    expect(turn).toBeDefined();
    const meta = (turn!.payload as { metadata?: { delivered?: string } }).metadata;
    expect(meta?.delivered).toBe('send_message');
    expect(turn!.text).toContain('here you go'); // flattened projection for recall
  });

  it('multi-bubble send → one row, both bubbles captured', async () => {
    const rt = createTestRuntime({ db: tdb.db, model: modelThatSends('on it', 'done!') });
    const ev = makeChannelEvent({ text: 'two things please' });
    await runOnce(rt, ev);
    expect(rt.gateway.texts()).toEqual(['on it', 'done!']);
    const win = await lastTurn(rt, ev.threadId);
    expect(win.filter((m) => m.role === 'assistant')).toHaveLength(1);
  });

  it('stay_silent turn → delivered=silence, nothing sent, no recovery', async () => {
    // Recovery must NOT run (default recoveryModel throws if it does).
    const rt = createTestRuntime({
      db: tdb.db,
      model: scriptModel([
        { toolCalls: [{ toolName: 'stay_silent', input: {} }] },
        { finishReason: 'stop' },
      ]),
    });
    const ev = makeChannelEvent({ text: '👍' });
    await runOnce(rt, ev);

    expect(rt.gateway.texts()).toEqual([]);
    const turn = (await lastTurn(rt, ev.threadId)).find((m) => m.role === 'assistant');
    const meta = (turn!.payload as { metadata?: { delivered?: string; recovered?: boolean } })
      .metadata;
    expect(meta?.delivered).toBe('silence');
    expect(meta?.recovered).toBeFalsy();
  });

  it('miss (scratch, no send/silent) → recovery composes a send; delivered=send_message', async () => {
    const rt = createTestRuntime({
      db: tdb.db,
      model: modelThatOnlyScratches('I think the answer is 42 but let me phrase it nicely'),
      recoveryModel: recoveryText("It's 42."),
    });
    const ev = makeChannelEvent({ text: 'what is the answer?' });
    await runOnce(rt, ev);

    // The recovery pass delivered a composed message (not the raw scratch).
    expect(rt.gateway.texts()).toEqual(["It's 42."]);
    const turn = (await lastTurn(rt, ev.threadId)).find((m) => m.role === 'assistant');
    const payload = turn!.payload as {
      parts: Array<{ type: string; input?: { text?: string } }>;
      metadata?: { delivered?: string; recovered?: boolean };
    };
    expect(payload.metadata?.delivered).toBe('send_message');
    expect(payload.metadata?.recovered).toBe(true);
    // The recovery send is coerced into history as a send_message tool call, so a
    // recovered miss is indistinguishable from a clean send (de-poisons history).
    expect(payload.parts.some((p) => p.type === 'tool-send_message')).toBe(true);
  });

  it('miss → recovery returns nothing → nothing delivered, recovered recorded', async () => {
    const rt = createTestRuntime({
      db: tdb.db,
      model: modelThatOnlyScratches('Only private reasoning here, nothing to say.'),
      recoveryModel: recoveryText(''), // backstop composed nothing to send
    });
    const ev = makeChannelEvent({ text: 'thanks!' });
    await runOnce(rt, ev);

    expect(rt.gateway.texts()).toEqual([]); // no ghost-leak of raw scratch
    const turn = (await lastTurn(rt, ev.threadId)).find((m) => m.role === 'assistant');
    const meta = (turn!.payload as { metadata?: { delivered?: string; recovered?: boolean } })
      .metadata;
    expect(meta?.recovered).toBe(true);
  });

  it('model error → user gets the error reply and the runner survives the next turn', async () => {
    const rt = createTestRuntime({ db: tdb.db, model: modelThatThrows() });
    const ev = makeChannelEvent({ text: 'boom' });
    await runOnce(rt, ev);
    expect(rt.gateway.texts().some((t) => /hit an error/i.test(t))).toBe(true);

    // The composition is unharmed: a fresh runner on the same DB handles a turn.
    const rt2 = createTestRuntime({
      db: tdb.db,
      model: modelThatSends('recovered'),
      config: rt.config,
    });
    const ev2 = makeChannelEvent({ messageId: 'after-error', text: 'still there?' });
    await runOnce(rt2, ev2);
    expect(rt2.gateway.texts()).toEqual(['recovered']);
  });

  describe('text delivery mode (candidate design)', () => {
    it("delivers the model's reply text directly, split into bubbles on blank lines", async () => {
      const rt = createTestRuntime({
        db: tdb.db,
        deliveryMode: 'text',
        model: modelThatOnlyScratches('Paris 🇫🇷\n\nAnything else?'),
      });
      const ev = makeChannelEvent({ text: 'capital of France?' });
      await runOnce(rt, ev);

      expect(rt.gateway.texts()).toEqual(['Paris 🇫🇷', 'Anything else?']); // two bubbles
      const turn = (await lastTurn(rt, ev.threadId)).find((m) => m.role === 'assistant');
      const meta = (turn!.payload as { metadata?: { delivered?: string } }).metadata;
      expect(meta?.delivered).toBe('send_message');
    });

    it('stay_silent → nothing delivered, delivered=silence (no send_message tool exists)', async () => {
      const rt = createTestRuntime({
        db: tdb.db,
        deliveryMode: 'text',
        model: scriptModel([
          { toolCalls: [{ toolName: 'stay_silent', input: {} }] },
          { finishReason: 'stop' },
        ]),
      });
      const ev = makeChannelEvent({ text: '👍' });
      await runOnce(rt, ev);

      expect(rt.gateway.texts()).toEqual([]);
      const turn = (await lastTurn(rt, ev.threadId)).find((m) => m.role === 'assistant');
      const meta = (turn!.payload as { metadata?: { delivered?: string } }).metadata;
      expect(meta?.delivered).toBe('silence');
    });
  });
});
