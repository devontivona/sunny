import { describe, expect, it } from 'vitest';
import { rawTypingSend } from './sendblue.js';

/**
 * Raw-client typing fallback (2026-07-05 investigation, typing gap #3): after any process
 * restart the in-memory `activeThreads` map is empty, so the handle-based `startTyping`
 * silently no-op'd until the next inbound webhook. `rawTypingSend` is the shared fallback
 * (and stopTyping's only path) — these pin its dispatch and its feature-detected no-ops.
 */
describe('rawTypingSend', () => {
  function fakeAdapter(decoded: { fromNumber: string; contactNumber?: string; groupId?: string }) {
    const calls: Record<string, unknown>[] = [];
    return {
      calls,
      adapter: {
        sdk: {
          typingIndicators: {
            send: (b: Record<string, unknown>) => {
              calls.push(b);
              return Promise.resolve({});
            },
          },
        },
        decodeThreadId: () => decoded,
      },
    };
  }

  it('sends start/stop through the raw client with decoded numbers (a DM)', async () => {
    const { adapter, calls } = fakeAdapter({ fromNumber: '+15550001111', contactNumber: '+19702229425' });
    await rawTypingSend(adapter, 'sendblue:x:y', 'start');
    await rawTypingSend(adapter, 'sendblue:x:y', 'stop');
    expect(calls).toEqual([
      { from_number: '+15550001111', number: '+19702229425', state: 'start' },
      { from_number: '+15550001111', number: '+19702229425', state: 'stop' },
    ]);
  });

  it('no-ops for a group thread (Sendblue has no group typing)', async () => {
    const { adapter, calls } = fakeAdapter({ fromNumber: '+15550001111', groupId: 'g1' });
    await rawTypingSend(adapter, 'sendblue:group:g1', 'start');
    expect(calls).toHaveLength(0);
  });

  it('no-ops safely when the adapter internals are missing (feature detection)', async () => {
    await expect(rawTypingSend({}, 'sendblue:x:y', 'start')).resolves.toBeUndefined();
    await expect(
      rawTypingSend({ decodeThreadId: () => ({ fromNumber: 'x' }) }, 't', 'stop'),
    ).resolves.toBeUndefined();
  });
});
