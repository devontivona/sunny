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

/** A gateway whose `send` throws for the watchdog apology note (simulating the same outage that
 *  hung the turn), but works for every other send. */
class ApologyFailingGateway extends FakeGateway {
  override async send(
    threadId: string,
    message: Parameters<FakeGateway['send']>[1],
    opts?: Parameters<FakeGateway['send']>[2],
  ): ReturnType<FakeGateway['send']> {
    if (/stuck on my end|partway/i.test(message.text)) throw new Error('outage: cannot send');
    return super.send(threadId, message, opts);
  }
}

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

  it('R7: a deterministically failing turn is retired after the cap — no unbounded loop, no endless re-send', async () => {
    const event = makeChannelEvent({ text: 'this turn always throws' });
    await store.appendInbound(event);

    const runsStarted: string[] = [];
    const router = new DurableTurnRouter(
      gateway,
      store,
      meta(5000), // watchdog irrelevant here — the turn REJECTS (it doesn't hang)
      async (threadId) => {
        runsStarted.push(threadId);
        // Sends a bubble, then rejects BEFORE marking answered — the R7 shape: a fresh run
        // re-sends the bubble every loop, so the inbound stays unanswered forever without a cap.
        await gateway.send(threadId, { text: 'partial bubble' }, { persist: false });
        return {
          runId: `fail-${runsStarted.length}`,
          returnValue: new Promise<void>((_, reject) =>
            setTimeout(() => reject(new Error('boom')), 1),
          ),
          cancel: async () => {},
        };
      },
      { maxConsecutiveFailures: 3, backoffMs: () => 5 },
    );

    router.route(event);

    // Retired after exactly the cap — not looping forever.
    await vi.waitFor(
      async () => expect(await store.hasUnansweredInbound(event.threadId)).toBe(false),
      { timeout: 3000 },
    );
    expect(runsStarted).toHaveLength(3);
    const retireNote = gateway.sent.filter((m) => /kept hitting an error/i.test(m.text));
    expect(retireNote).toHaveLength(1);
    expect(retireNote[0]!.persist).toBe(true);

    // And it STAYS retired: no further runs, no further re-sends of the partial bubble.
    await sleep(200);
    expect(runsStarted).toHaveLength(3);
    expect(gateway.texts().filter((t) => t === 'partial bubble')).toHaveLength(3);
  });

  it('Watchdog: a FAILED apology send does not silently consume the messages — the worker retries', async () => {
    const event = makeChannelEvent({ text: 'will hang, and the apology send will fail too' });
    await store.appendInbound(event);

    // The same outage that hung the turn also fails the apology send (only the watchdog note).
    const gw = new ApologyFailingGateway();
    let call = 0;
    const hung = fakeRunHandle('hung-then-recovered');
    const router = new DurableTurnRouter(
      gw,
      store,
      meta(60),
      async (threadId) => {
        call += 1;
        if (call === 1) return hung.handle; // hangs → watchdog fires → apology send THROWS
        // The retry (the outage has passed): a healthy turn actually answers.
        const healthy = fakeRunHandle(`healthy-${call}`);
        void (async () => {
          await gw.send(threadId, { text: 'recovered — here you go' }, { persist: false });
          const pending = await store.unansweredSteers(threadId, []);
          await store.markAnsweredForThread(
            threadId,
            pending.map((p) => p.messageId),
          );
          healthy.resolve();
        })();
        return healthy.handle;
      },
      { maxConsecutiveFailures: 5, backoffMs: () => 5 },
    );

    router.route(event);

    // The failed apology must NOT have retired the inbound: the worker re-runs and answers it.
    await vi.waitFor(() => expect(gw.texts()).toContain('recovered — here you go'), {
      timeout: 3000,
    });
    expect(call).toBeGreaterThanOrEqual(2); // it re-ran rather than swallowing the messages
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
