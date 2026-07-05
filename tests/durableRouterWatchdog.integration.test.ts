import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DurableTurnRouter, type TurnRunHandle } from '../src/agent/durableRouter.js';
import { ConversationStore } from '../src/gateway/store.js';
import { createTestDb, type TestDb } from './db.js';
import { FakeGateway } from './fakes/gateway.js';
import { makeChannelEvent } from './factories.js';

/**
 * Turn-run watchdog — the production fix for the hung-model-stream exposure (2026-07-03: a
 * stalled Anthropic stream hung one turn 73+ min; the per-thread router serializes turns, so
 * the whole conversation went silent). These drive the REAL router + REAL store (PGlite) with
 * an injected `TurnRunner` (the seam production fills with a WDK run), proving the three
 * watchdog guarantees end to end:
 *
 *  1. a hung run is detected and handled within the threshold (cancel + retire + user note);
 *  2. the recovery NEVER double-texts — the inbound is retired, so the worker loop does not
 *     start a fresh run that would re-answer from scratch (the PR #29 duplicate-reply class);
 *  3. a healthy turn — even a slow one — is not killed.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A controllable fake turn-run: hangs by default; `resolve()` completes it. */
function fakeRunHandle(runId: string): {
  handle: TurnRunHandle;
  resolve: () => void;
  cancelled: () => boolean;
} {
  let release!: () => void;
  let cancelled = false;
  const returnValue = new Promise<void>((r) => (release = r));
  return {
    handle: {
      runId,
      returnValue,
      cancel: async () => {
        cancelled = true;
      },
    },
    resolve: release,
    cancelled: () => cancelled,
  };
}

describe('DurableTurnRouter watchdog (hung turn-runs)', () => {
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

  const meta = (turnWatchdogMs: number) => ({
    modelId: 'claude-sonnet-5',
    effort: 'high' as string | null,
    turnWatchdogMs,
  });

  it('abandons a hung run within the threshold: cancels it, retires the inbound, tells the user — and never re-runs', async () => {
    const event = makeChannelEvent({ text: 'do the thing' });
    await store.appendInbound(event);

    const runsStarted: string[] = [];
    const run = fakeRunHandle('run-hung-1');
    const router = new DurableTurnRouter(
      gateway,
      store,
      meta(60), // fire fast in test; production default is 10 min
      async (threadId) => {
        runsStarted.push(threadId);
        return run.handle; // hangs forever — the stalled-stream shape
      },
    );

    router.route(event);

    // Detected and handled within the threshold: the explicit user note lands.
    await vi.waitFor(() => expect(gateway.sendCount).toBe(1), { timeout: 3000 });
    expect(gateway.texts()[0]).toMatch(/stuck on my end/i);
    expect(gateway.sent[0]!.persist).toBe(true); // the loss is visible in history

    // The zombie was cancelled in the world, and the inbound was retired.
    expect(run.cancelled()).toBe(true);
    expect(await store.hasUnansweredInbound(event.threadId)).toBe(false);

    // THE double-text guard: the worker loop must NOT start a fresh run for the same
    // message (a fresh run is not a replay — it would re-answer from scratch).
    await sleep(200);
    expect(runsStarted).toHaveLength(1);
    expect(gateway.sendCount).toBe(1); // the note, nothing else
  });

  it('uses the partial-delivery wording when the hung turn already sent something', async () => {
    const event = makeChannelEvent({ text: 'long task please' });
    await store.appendInbound(event);

    const run = fakeRunHandle('run-hung-2');
    const router = new DurableTurnRouter(gateway, store, meta(80), async (threadId) => {
      // The turn delivers an interim bubble (translator update / early send), THEN hangs.
      // Delay so the send lands strictly after the router's startedAt millisecond.
      void sleep(10).then(() =>
        gateway.send(threadId, { text: 'on it — digging in…' }, { persist: false }),
      );
      return run.handle;
    });

    router.route(event);

    await vi.waitFor(() => expect(gateway.sendCount).toBe(2), { timeout: 3000 });
    expect(gateway.texts()[0]).toBe('on it — digging in…');
    expect(gateway.texts()[1]).toMatch(/partway/i);
    expect(run.cancelled()).toBe(true);

    // Still exactly-once: nothing re-runs, nothing re-sends the interim bubble.
    await sleep(200);
    expect(gateway.sendCount).toBe(2);
    expect(await store.hasUnansweredInbound(event.threadId)).toBe(false);
  });

  it('does NOT kill a healthy turn that finishes under the threshold (a slow turn is not a hung turn)', async () => {
    const event = makeChannelEvent({ text: 'quick one' });
    await store.appendInbound(event);

    const run = fakeRunHandle('run-healthy');
    const router = new DurableTurnRouter(gateway, store, meta(5000), async (threadId) => {
      // A slow-but-healthy turn: works for a bit, replies, marks its window answered
      // (what the real run's sendStep + markAnswered steps do), then completes.
      void (async () => {
        await sleep(50);
        await gateway.send(threadId, { text: 'here you go' }, { persist: false });
        await store.markAnsweredForThread(threadId, [event.messageId]);
        run.resolve();
      })();
      return run.handle;
    });

    router.route(event);

    await vi.waitFor(() => expect(gateway.sendCount).toBe(1), { timeout: 3000 });
    await sleep(150); // past the turn's completion; nowhere near the 5s watchdog
    expect(run.cancelled()).toBe(false);
    expect(gateway.texts()).toEqual(['here you go']); // no watchdog note
    expect(await store.hasUnansweredInbound(event.threadId)).toBe(false);
  });

  it('leaves the thread healthy after an abandon: the next inbound gets a fresh turn', async () => {
    const first = makeChannelEvent({ text: 'this one will hang' });
    await store.appendInbound(first);

    let call = 0;
    const hungRun = fakeRunHandle('run-hung-3');
    const router = new DurableTurnRouter(gateway, store, meta(60), async (threadId) => {
      call += 1;
      if (call === 1) return hungRun.handle; // first turn hangs
      // Second turn is healthy: answer + mark + complete.
      const healthy = fakeRunHandle(`run-${call}`);
      void (async () => {
        await gateway.send(threadId, { text: 'answered the retry' }, { persist: false });
        const pending = await store.unansweredSteers(threadId, []);
        await store.markAnsweredForThread(
          threadId,
          pending.map((p) => p.messageId),
        );
        healthy.resolve();
      })();
      return healthy.handle;
    });

    router.route(first);
    await vi.waitFor(() => expect(gateway.sendCount).toBe(1), { timeout: 3000 }); // the note
    expect(hungRun.cancelled()).toBe(true);

    // The user resends (as the note asked) — the thread must not be wedged.
    const second = makeChannelEvent({ text: 'ok trying again', threadId: first.threadId });
    await store.appendInbound(second);
    router.route(second);

    await vi.waitFor(() => expect(gateway.texts()).toContain('answered the retry'), {
      timeout: 3000,
    });
    expect(call).toBe(2);
    expect(await store.hasUnansweredInbound(first.threadId)).toBe(false);
  });
});
