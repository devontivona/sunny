import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConversationStore } from '../src/gateway/store.js';
import { steerMessageText } from '../src/agent/delivery.js';
import { createTestDb, type TestDb } from './db.js';
import { FakeGateway } from './fakes/gateway.js';
import {
  makeAssistantTurnPayload,
  makeChannelEvent,
  GROUP_THREAD,
  OWNER_THREAD,
} from './factories.js';

/**
 * Durable Tier-1 conversational run — behavior verification (durable-main-loop tasks
 * 5.1–5.3).
 *
 * WDK doesn't run on single-connection PGlite (it needs multi-connection LISTEN/NOTIFY),
 * so — following `durableStep.integration.test.ts` — these exercise the run's CONSTITUENT
 * guarantees against the real store + the shared, pure helpers, MODELING the WDK step
 * boundary where the real durability lives. A `'use step'` is memoized by a deterministic
 * id: a replay returns the recorded result WITHOUT re-running `execute`. The full
 * crash/resume path is a live boundary (TEST_DATABASE_URL real-PG hatch), exercised
 * manually per tasks 5.4–5.7.
 */

/** Models a WDK step boundary: run `fn` once per step id; replays return the cache
 *  (mirrors `durableStep.integration.test.ts`). */
function makeReplayableSteps() {
  const cache = new Map<string, unknown>();
  return async function step<T>(id: string, fn: () => Promise<T>): Promise<T> {
    if (cache.has(id)) return cache.get(id) as T; // replay → no re-execution
    const result = await fn();
    cache.set(id, result);
    return result;
  };
}

describe('durable conversational run', () => {
  let tdb: TestDb;
  let store: ConversationStore;
  let gateway: FakeGateway;

  beforeEach(async () => {
    tdb = await createTestDb();
    store = new ConversationStore(tdb.db, 30);
    gateway = new FakeGateway();
  });
  afterEach(async () => {
    await tdb.teardown();
  });

  // --- 5.1 ----------------------------------------------------------------
  describe('5.1 crash mid-turn resumes from last step; exactly one outbound on replay', () => {
    /** Model one turn as the durable run does: deliver (step) → persist (step) → mark
     *  answered (step). Wrapping in the SAME replayable `step` and re-running models a
     *  crash + resume from the journal — completed steps return their recorded result. */
    async function runModeledTurn(
      step: ReturnType<typeof makeReplayableSteps>,
      threadId: string,
      inboundId: string,
      reply: string,
    ): Promise<void> {
      await step(`send:${reply}`, () =>
        gateway.send(threadId, { text: reply }, { persist: false }),
      );
      await step('persist', () =>
        store.appendTurn(threadId, makeAssistantTurnPayload({ sends: [reply] }), reply),
      );
      await step('mark', () => store.markProcessedMany('imessage', [inboundId]));
    }

    it('a replayed turn delivers exactly one outbound and persists one row', async () => {
      const event = makeChannelEvent({ text: 'hey' });
      await store.appendInbound(event);

      const step = makeReplayableSteps();
      await runModeledTurn(step, event.threadId, event.messageId, 'on it');
      // Crash after the turn's steps completed, then resume from the same journal.
      await runModeledTurn(step, event.threadId, event.messageId, 'on it');

      expect(gateway.sendCount).toBe(1); // memoized send NOT repeated on replay
      const window = await store.recentWindow(event.threadId);
      expect(window.filter((m) => m.role === 'assistant')).toHaveLength(1); // one turn row
      expect(await store.hasUnansweredInbound(event.threadId)).toBe(false);
    });

    it('without the step boundary, a re-run WOULD double-send (motivates memoization)', async () => {
      const event = makeChannelEvent({ text: 'hey' });
      await store.appendInbound(event);
      // No step cache: a naive re-run re-executes every side effect.
      await gateway.send(event.threadId, { text: 'on it' }, { persist: false });
      await gateway.send(event.threadId, { text: 'on it' }, { persist: false });
      expect(gateway.sendCount).toBe(2);
    });
  });

  // --- 5.2 ----------------------------------------------------------------
  describe('5.2 a mid-turn steer folds into the in-flight turn; a later steer starts the next turn', () => {
    it('surfaces a message that arrived mid-turn, excluding what the model already saw', async () => {
      // Turn started on message A → A's id is in the prompt window (excluded).
      const a = makeChannelEvent({ text: 'plan my trip' });
      await store.appendInbound(a);

      // Nothing new yet → prepareStep folds nothing.
      expect(await store.unansweredSteers(a.threadId, [a.messageId])).toEqual([]);

      // A second text lands MID-TURN (persisted on arrival). It is NOT in the excluded
      // window, so prepareStep's loadSteers surfaces it to fold into the next step.
      const b = makeChannelEvent({ text: 'somewhere warm, Friday' });
      await store.appendInbound(b);
      const steers = await store.unansweredSteers(b.threadId, [a.messageId]);
      expect(steers.map((s) => s.messageId)).toEqual([b.messageId]);
      // The fold renders it as a user message (group prefix preserved by steerMessageText).
      expect(steerMessageText(steers[0]!.text, steers[0]!.senderName, false)).toBe(
        'somewhere warm, Friday',
      );

      // Once folded (added to excludeIds), it is not surfaced again on later steps.
      expect(await store.unansweredSteers(b.threadId, [a.messageId, b.messageId])).toEqual([]);
    });

    it('group steers carry the speaker prefix when folded', async () => {
      const a = makeChannelEvent({ threadId: GROUP_THREAD, isGroup: true, text: 'design a logo' });
      const b = makeChannelEvent({
        threadId: GROUP_THREAD,
        isGroup: true,
        text: 'make it blue',
        senderName: 'Alex',
        isOwner: false,
      });
      await store.appendInbound(a);
      await store.appendInbound(b);
      const [steer] = await store.unansweredSteers(GROUP_THREAD, [a.messageId]);
      expect(steerMessageText(steer!.text, steer!.senderName, true)).toBe('Alex: make it blue');
    });

    it('a steer that arrives after the turn finished is answered as the next turn (watermark), not a competing run', async () => {
      // Turn 1 answers message A (folded nothing) and marks it processed.
      const a = makeChannelEvent({ text: 'plan my trip' });
      await store.appendInbound(a);
      await store.markProcessedMany('imessage', [a.messageId]);
      expect(await store.hasUnansweredInbound(a.threadId)).toBe(false);

      // B lands after the run parked on the hook → wake → next turn answers it, same run.
      const b = makeChannelEvent({ text: 'actually, somewhere cold' });
      await store.appendInbound(b);
      expect(await store.hasUnansweredInbound(b.threadId)).toBe(true);
      expect(await store.windowUserIds(b.threadId)).toContain(b.messageId);
    });
  });

  // --- 5.3 ----------------------------------------------------------------
  describe('5.3 idempotent inbound (webhook retry) processed once', () => {
    it('a duplicate inbound is deduped on arrival and never double-counted', async () => {
      const event = makeChannelEvent({ text: 'hey sunny' });
      expect(await store.appendInbound(event)).toBe(true); // first insert
      expect(await store.appendInbound(event)).toBe(false); // webhook retry → no-op

      const ids = await store.windowUserIds(event.threadId);
      expect(ids.filter((id) => id === event.messageId)).toHaveLength(1); // stored once
      expect(await store.hasUnansweredInbound(event.threadId)).toBe(true);

      // Answering it once marks it processed; a later retry stays deduped, so no re-answer.
      await store.markProcessedMany('imessage', [event.messageId]);
      expect(await store.hasUnansweredInbound(event.threadId)).toBe(false);
      expect(await store.appendInbound(event)).toBe(false);
      expect(await store.hasUnansweredInbound(event.threadId)).toBe(false);
    });
  });
});
