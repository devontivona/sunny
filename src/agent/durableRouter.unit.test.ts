import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The router starts/awaits durable runs via `workflow/api`; mock it so the serial-worker logic
// can be tested without a WDK world. The workflow fn is only passed to (mocked) `start`.
vi.mock('workflow/api', () => ({ start: vi.fn(), getRun: vi.fn() }));
vi.mock('../../workflows/conversation.js', () => ({ runConversation: () => undefined }));

import { getRun, start } from 'workflow/api';
import { DurableTurnRouter } from './durableRouter.js';
import { FakeGateway } from '../../tests/fakes/gateway.js';
import { makeChannelEvent } from '../../tests/factories.js';

/** A run handle whose `returnValue` resolves when `release()` is called (to control timing). */
function fakeRun(runId: string): {
  run: { runId: string; returnValue: Promise<void> };
  release: () => void;
} {
  let release!: () => void;
  const returnValue = new Promise<void>((r) => (release = r));
  return { run: { runId, returnValue }, release };
}

/** A store stub whose `hasUnansweredInbound` yields a scripted sequence, then false. */
function fakeStore(seq: boolean[]) {
  let i = 0;
  return {
    hasUnansweredInbound: vi.fn(async () => (i < seq.length ? seq[i++]! : false)),
  } as unknown as ConstructorParameters<typeof DurableTurnRouter>[1];
}

const META = {
  modelId: 'claude-opus-4-8',
  effort: 'high' as string | null,
  // Generous: these tests exercise the serial worker, never the watchdog (see
  // tests/durableRouterWatchdog.integration.test.ts for the abandon path).
  turnWatchdogMs: 600_000,
  turnInactivityMs: 600_000,
};

/** Serial-worker tests opt out of the inbound quiet period (multipart-coalesce) — the
 *  coalescing behavior itself is pinned in its own describe block below. */
const NO_COALESCE = { quietMs: 0, quietMediaMs: 0 };

const makeRouter = (
  gateway: FakeGateway,
  store: ConstructorParameters<typeof DurableTurnRouter>[1],
  coalesce = NO_COALESCE,
) => new DurableTurnRouter(gateway, store, META, undefined, undefined, coalesce);

describe('DurableTurnRouter (serial worker)', () => {
  let gateway: FakeGateway;

  beforeEach(() => {
    gateway = new FakeGateway();
    // A turn-run's stream bridge reads an immediately-closed readable.
    vi.mocked(getRun).mockReturnValue({
      getReadable: () => ({
        getReader: () => ({
          read: vi.fn().mockResolvedValue({ done: true }),
          cancel: vi.fn().mockResolvedValue(undefined),
          releaseLock: vi.fn(),
        }),
      }),
      status: Promise.resolve('completed'),
    } as never);
  });
  afterEach(() => vi.clearAllMocks());

  it('starts one turn-run for an unanswered thread, then stops when nothing is unanswered', async () => {
    const { run, release } = fakeRun('r1');
    vi.mocked(start).mockResolvedValue(run as never);
    const store = fakeStore([true]); // unanswered once, then false

    makeRouter(gateway, store).route(makeChannelEvent());
    await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    release();
    // After the run, the worker re-checks and exits (no second run).
    await new Promise((r) => setTimeout(r, 20));
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('drains multiple unanswered turns SEQUENTIALLY on one worker (never concurrent)', async () => {
    const handles = [fakeRun('r1'), fakeRun('r2'), fakeRun('r3')];
    let n = 0;
    let concurrent = 0;
    let maxConcurrent = 0;
    vi.mocked(start).mockImplementation(async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      const h = handles[n++]!;
      void h.run.returnValue.then(() => concurrent--);
      return h.run as never;
    });
    const store = fakeStore([true, true, true]); // three turns, then stop

    makeRouter(gateway, store).route(makeChannelEvent());
    await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    // Release each run in order; the worker should start the next only after the prior resolves.
    for (const h of handles) {
      h.release();
      await new Promise((r) => setTimeout(r, 5));
    }
    await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(3));
    expect(maxConcurrent).toBe(1); // strictly serialized
  });

  it('does not spawn a second worker when a thread is already processing', async () => {
    const { run, release } = fakeRun('r1');
    vi.mocked(start).mockResolvedValue(run as never);
    const store = fakeStore([true]); // only one unanswered turn exists
    const router = makeRouter(gateway, store);

    const event = makeChannelEvent();
    router.route(event);
    router.route(event); // second inbound while the first turn is still running
    await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1));

    release();
    await new Promise((r) => setTimeout(r, 20));
    // The second route set `dirty`, the worker re-checked the store, found nothing new, exited.
    expect(start).toHaveBeenCalledTimes(1);
  });
});

describe('DurableTurnRouter (multipart-coalesce)', () => {
  let gateway: FakeGateway;

  beforeEach(() => {
    gateway = new FakeGateway();
    vi.mocked(getRun).mockReturnValue({
      getReadable: () => ({
        getReader: () => ({
          read: vi.fn().mockResolvedValue({ done: true }),
          cancel: vi.fn().mockResolvedValue(undefined),
          releaseLock: vi.fn(),
        }),
      }),
      status: Promise.resolve('completed'),
    } as never);
  });
  afterEach(() => vi.clearAllMocks());

  it('waits for the quiet period before starting a turn, and a trickle of parts extends it', async () => {
    const { run, release } = fakeRun('r1');
    vi.mocked(start).mockResolvedValue(run as never);
    const store = fakeStore([true]);
    const router = makeRouter(gateway, store, { quietMs: 80, quietMediaMs: 200 });

    router.route(makeChannelEvent({ text: 'part one' }));
    await new Promise((r) => setTimeout(r, 50));
    expect(start).not.toHaveBeenCalled(); // still inside part one's quiet window
    router.route(makeChannelEvent({ text: 'part two' })); // extends the window
    await new Promise((r) => setTimeout(r, 50));
    expect(start).not.toHaveBeenCalled(); // part two reset the clock

    await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1), { timeout: 500 });
    release();
    // One coalesced turn — the second part never spawned its own run.
    await new Promise((r) => setTimeout(r, 20));
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('media / bare-URL / empty-text parts get the LONGER quiet window (multipart signature)', async () => {
    const { run, release } = fakeRun('r1');
    vi.mocked(start).mockResolvedValue(run as never);
    const store = fakeStore([true]);
    const router = makeRouter(gateway, store, { quietMs: 30, quietMediaMs: 220 });

    // A bare link bubble — its preview/attachment webhooks typically trail by seconds.
    router.route(makeChannelEvent({ text: 'https://example.com/thing' }));
    await new Promise((r) => setTimeout(r, 120));
    expect(start).not.toHaveBeenCalled(); // beyond quietMs, still inside quietMediaMs

    await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1), { timeout: 500 });
    release();
  });

  it('recovery/wake paths (no live inbound entry) start immediately', async () => {
    const { run, release } = fakeRun('r1');
    vi.mocked(start).mockResolvedValue(run as never);
    const store = fakeStore([true]);
    const router = makeRouter(gateway, store, { quietMs: 5_000, quietMediaMs: 5_000 });

    router.wake(makeChannelEvent().threadId); // out-of-band wake — no quiet entry
    await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1), { timeout: 300 });
    release();
  });
});
