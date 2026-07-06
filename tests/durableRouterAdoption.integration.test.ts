import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DurableTurnRouter, type TurnRunHandle } from '../src/agent/durableRouter.js';
import { ConversationStore } from '../src/gateway/store.js';
import { createTestDb, type TestDb } from './db.js';
import { FakeGateway } from '../tests/fakes/gateway.js';
import { makeChannelEvent } from './factories.js';

/**
 * Restart-orphan adoption (2026-07-05 investigation, problem 3). A turn-run in flight when
 * the process died resumes in the WDK world; the router must ADOPT it into the thread's
 * serial worker so restart recovery queues BEHIND it — the old design awaited orphans on a
 * 30s global bound and then started a SECOND full run for the same inbound (the PR #29
 * duplicate-reply class: production double-answered a 7-minute turn). These drive the REAL
 * router + REAL store with controllable fakes.
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fakeRunHandle(runId: string): { handle: TurnRunHandle; resolve: () => void } {
  let release!: () => void;
  const returnValue = new Promise<void>((r) => (release = r));
  return {
    handle: { runId, returnValue, cancel: async () => {} },
    resolve: release,
  };
}

describe('DurableTurnRouter orphan adoption (restart safety)', () => {
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

  const meta = {
    modelId: 'claude-sonnet-5',
    effort: 'high' as string | null,
    turnWatchdogMs: 5000,
  };

  it('recovery queues BEHIND a healthy adopted orphan — never a duplicate run', async () => {
    // The restart shape: an inbound is persisted but unanswered, and the run answering it
    // is still alive in the WDK world.
    const event = makeChannelEvent({ text: 'long task from before the restart' });
    await store.appendInbound(event);

    const runsStarted: string[] = [];
    const orphan = fakeRunHandle('run-orphan-1');
    const router = new DurableTurnRouter(gateway, store, meta, async (threadId) => {
      runsStarted.push(threadId);
      const fresh = fakeRunHandle(`fresh-${runsStarted.length}`);
      fresh.resolve();
      return fresh.handle;
    });

    // Boot order: adopt the orphan, then recovery marks the thread dirty.
    router.adoptRun(event.threadId, orphan.handle);
    await router.recoverPending([event]);

    // While the orphan is still running, recovery must NOT have started a fresh run.
    await sleep(150);
    expect(runsStarted).toHaveLength(0);

    // The orphan finishes its turn: it marks its inbound answered (what a completing turn
    // does), then resolves. The worker drains: nothing unanswered → no fresh run EVER.
    await store.markAnsweredForThread(event.threadId, [event.messageId]);
    orphan.resolve();
    await sleep(200);
    expect(runsStarted).toHaveLength(0);
  });

  it('a failed orphan (marked nothing) is re-answered exactly once, serially after it settles', async () => {
    const event = makeChannelEvent({ text: 'turn that died on a code change' });
    await store.appendInbound(event);

    const runsStarted: string[] = [];
    const orphan = fakeRunHandle('run-orphan-2');
    const router = new DurableTurnRouter(gateway, store, meta, async (threadId) => {
      runsStarted.push(threadId);
      // The fresh run answers properly: marks the inbound, then completes.
      await store.markAnsweredForThread(threadId, [event.messageId]);
      const fresh = fakeRunHandle('fresh-after-orphan');
      fresh.resolve();
      return fresh.handle;
    });

    router.adoptRun(event.threadId, orphan.handle);
    await router.recoverPending([event]);
    await sleep(100);
    expect(runsStarted).toHaveLength(0); // still queued behind the orphan

    // Orphan dies without marking anything (replay divergence after a deploy).
    orphan.resolve();
    await vi.waitFor(() => expect(runsStarted).toHaveLength(1), { timeout: 3000 });

    // Exactly one re-answer — not one per recovery signal.
    await sleep(200);
    expect(runsStarted).toHaveLength(1);
    expect(await store.hasUnansweredInbound(event.threadId)).toBe(false);
  });

  it('adopting THREE running runs for the same thread tracks and drives ALL (no last-wins drop)', async () => {
    // A thread can have 3+ runs RUNNING at restart (e.g. mid-turn steers spawned extra runs).
    // adoptRun is called in a synchronous loop: the first adopt starts the worker (which
    // synchronously consumes orphan #1 and suspends on its drive), so #2 and #3 land while the
    // worker is BUSY — a last-wins `.set` overwrites #2 with #3, and #2 is never
    // driven/watchdogged/cancelled. Track every same-thread orphan instead.
    const event = makeChannelEvent({ text: 'three orphans from before the restart' });
    await store.appendInbound(event);

    const cancelled = [false, false, false];
    const orphans: TurnRunHandle[] = cancelled.map((_, i) => ({
      runId: `orphan-${i}`,
      returnValue: new Promise<void>(() => {}), // hangs → watchdog abandons → cancel()
      cancel: async () => {
        cancelled[i] = true;
      },
    }));

    const router = new DurableTurnRouter(
      gateway,
      store,
      { ...meta, turnWatchdogMs: 50 },
      async () => {
        throw new Error('no fresh runs expected — every orphan should be driven');
      },
    );

    for (const o of orphans) router.adoptRun(event.threadId, o);

    // EVERY orphan is driven through the full machinery and watchdog-abandoned; the last-wins
    // bug would leave the middle one (overwritten while the worker was busy) never cancelled.
    await vi.waitFor(() => expect(cancelled).toEqual([true, true, true]), { timeout: 4000 });
  });

  it('an adopted orphan gets the watchdog: a hung orphan is abandoned, not eternal', async () => {
    const event = makeChannelEvent({ text: 'hung since before the restart' });
    await store.appendInbound(event);

    let cancelled = false;
    const hung: TurnRunHandle = {
      runId: 'run-orphan-hung',
      returnValue: new Promise<void>(() => {}),
      cancel: async () => {
        cancelled = true;
      },
    };
    const router = new DurableTurnRouter(
      gateway,
      store,
      { ...meta, turnWatchdogMs: 60 },
      async () => {
        throw new Error('no fresh runs expected');
      },
    );

    router.adoptRun(event.threadId, hung);

    await vi.waitFor(() => expect(gateway.sendCount).toBe(1), { timeout: 3000 });
    expect(cancelled).toBe(true);
    expect(await store.hasUnansweredInbound(event.threadId)).toBe(false); // retired, no re-run
  });
});
