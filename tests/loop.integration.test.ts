import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SteerHandle } from '../src/agent/dispatcher.js';
import type { ChannelEvent } from '../src/gateway/types.js';
import { createTestDb, type TestDb } from './db.js';
import { createTestRuntime, type TestRuntime } from './harness.js';
import { makeChannelEvent } from './factories.js';
import { modelThatOnlyScratches, modelThatSends, modelThatThrows } from './fakes/model.js';

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

  it('scratch-only turn → nothing delivered, flagged as fallback_text (no autosend)', async () => {
    const rt = createTestRuntime({ db: tdb.db, model: modelThatOnlyScratches('a private reply') });
    const ev = makeChannelEvent({ text: 'hi' });
    await runOnce(rt, ev);

    // Raw model text is private (D-MG8): the user hears NOTHING this turn…
    expect(rt.gateway.texts()).toEqual([]);
    // …but the miss is still recorded as telemetry on the persisted turn.
    const turn = (await lastTurn(rt, ev.threadId)).find((m) => m.role === 'assistant');
    const meta = (turn!.payload as { metadata?: { delivered?: string } }).metadata;
    expect(meta?.delivered).toBe('fallback_text');
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
});
