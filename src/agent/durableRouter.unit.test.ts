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
};

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

    new DurableTurnRouter(gateway, store, META).route(makeChannelEvent());
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

    new DurableTurnRouter(gateway, store, META).route(makeChannelEvent());
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
    const router = new DurableTurnRouter(gateway, store, META);

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
