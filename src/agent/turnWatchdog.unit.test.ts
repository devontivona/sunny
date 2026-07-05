import { describe, expect, it } from 'vitest';
import { raceTurnWatchdog, TurnWatchdogTimeout } from './turnWatchdog.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('raceTurnWatchdog', () => {
  it('passes through a promise that settles within the budget (a healthy turn is not killed)', async () => {
    await expect(raceTurnWatchdog(Promise.resolve('done'), 1000)).resolves.toBe('done');

    const slowButHealthy = sleep(30).then(() => 'late but fine');
    await expect(raceTurnWatchdog(slowButHealthy, 5000)).resolves.toBe('late but fine');
  });

  it('propagates a rejection that happens within the budget (a failed run is not a timeout)', async () => {
    const boom = new Error('run failed');
    await expect(raceTurnWatchdog(Promise.reject(boom), 1000)).rejects.toBe(boom);
  });

  it('rejects with TurnWatchdogTimeout when the promise hangs past the budget', async () => {
    const hung = new Promise<never>(() => {}); // never settles — the stalled-stream shape
    const startedAt = Date.now();
    await expect(raceTurnWatchdog(hung, 50)).rejects.toBeInstanceOf(TurnWatchdogTimeout);
    // Fired at ~the budget, not eventually: detection is bounded by the threshold.
    expect(Date.now() - startedAt).toBeLessThan(1000);
  });

  it('carries the budget on the timeout error', async () => {
    const hung = new Promise<never>(() => {});
    const err = await raceTurnWatchdog(hung, 25).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TurnWatchdogTimeout);
    expect((err as TurnWatchdogTimeout).timeoutMs).toBe(25);
  });

  it("defuses the abandoned promise's LATER rejection (no unhandled rejection from the zombie)", async () => {
    const unhandled: unknown[] = [];
    const listener = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', listener);
    try {
      let rejectLater!: (e: Error) => void;
      const zombie = new Promise<never>((_, rej) => {
        rejectLater = rej;
      });
      await expect(raceTurnWatchdog(zombie, 10)).rejects.toBeInstanceOf(TurnWatchdogTimeout);
      // The abandoned run's steps fail much later (e.g. after teardown) — must be swallowed.
      rejectLater(new Error('zombie step failed after abandonment'));
      await sleep(30); // give the loop a beat to surface an unhandled rejection, if any
      expect(unhandled).toHaveLength(0);
    } finally {
      process.off('unhandledRejection', listener);
    }
  });
});
