import { describe, expect, it } from 'vitest';
import { runSerial } from './serial.js';

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('runSerial', () => {
  it('runs same-key tasks strictly in invocation order, never overlapping', async () => {
    const chain = new Map<string, Promise<unknown>>();
    const events: string[] = [];
    let active = 0;
    let maxActive = 0;
    const task = (id: string, ms: number) => () =>
      (async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        events.push(`start:${id}`);
        await tick(ms);
        events.push(`end:${id}`);
        active--;
        return id;
      })();

    // A is slow, B and C are fast — without serialization B/C would finish before A.
    const a = runSerial(chain, 't', task('A', 30));
    const b = runSerial(chain, 't', task('B', 1));
    const c = runSerial(chain, 't', task('C', 1));
    await Promise.all([a, b, c]);

    expect(maxActive).toBe(1); // never two at once for the same key
    expect(events).toEqual(['start:A', 'end:A', 'start:B', 'end:B', 'start:C', 'end:C']);
  });

  it('runs different keys concurrently', async () => {
    const chain = new Map<string, Promise<unknown>>();
    let active = 0;
    let maxActive = 0;
    const task = () => () =>
      (async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await tick(10);
        active--;
      })();
    await Promise.all([runSerial(chain, 'x', task()), runSerial(chain, 'y', task())]);
    expect(maxActive).toBe(2); // independent keys do not block each other
  });

  it('a failed task does not block (or wedge) the next on the same key', async () => {
    const chain = new Map<string, Promise<unknown>>();
    const a = runSerial(chain, 't', () => Promise.reject(new Error('boom')));
    const b = runSerial(chain, 't', () => Promise.resolve('ok'));
    await expect(a).rejects.toThrow('boom');
    await expect(b).resolves.toBe('ok');
  });
});
