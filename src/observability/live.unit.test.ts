import { describe, expect, it } from 'vitest';
import type { UIMessageChunk } from 'ai';
import { LiveBus, type LiveEvent } from './live.js';
import { createRedactor } from './redact.js';

// Live bus (live-conversation-streaming, task 9.1): subscribe/publish ordering,
// late-join replay, step counting, redaction, terminal status, and idle no-ops.

const chunk = (c: Record<string, unknown>): UIMessageChunk => c as unknown as UIMessageChunk;
const collect = () => {
  const events: LiveEvent[] = [];
  return { events, fn: (e: LiveEvent) => void events.push(e) };
};

function register(bus: LiveBus, runId = 'r1', threadId: string | null = 't1') {
  bus.registerTurn({ runId, threadId, label: 'You', model: 'claude-opus-4-8', effort: 'high' });
}

describe('LiveBus — publish & subscribe', () => {
  it('replays buffered chunks and current status to a late subscriber, then tails', () => {
    const bus = new LiveBus(createRedactor());
    register(bus);
    bus.publishTurnChunk('r1', chunk({ type: 'text-delta', id: 'a', delta: 'hi' }));

    const { events, fn } = collect();
    const unsub = bus.subscribeTurn('r1', fn);
    // On subscribe: a status snapshot then the one buffered chunk.
    expect(events[0]).toMatchObject({ type: 'status', run: { runId: 'r1', status: 'running' } });
    expect(events[1]).toMatchObject({ type: 'chunk' });

    // Subsequent chunks tail live.
    bus.publishTurnChunk('r1', chunk({ type: 'text-delta', id: 'a', delta: ' there' }));
    expect(events.at(-1)).toMatchObject({ type: 'chunk' });

    unsub();
    bus.publishTurnChunk('r1', chunk({ type: 'text-delta', id: 'a', delta: ' more' }));
    expect(events.filter((e) => e.type === 'chunk')).toHaveLength(2); // no events after unsub
  });

  it('counts a step on each start-step chunk and emits a status update', () => {
    const bus = new LiveBus(createRedactor());
    register(bus);
    const { events, fn } = collect();
    bus.subscribeTurn('r1', fn);
    bus.publishTurnChunk('r1', chunk({ type: 'start-step' }));
    bus.publishTurnChunk('r1', chunk({ type: 'start-step' }));
    expect(bus.getTurn('r1')?.steps).toBe(2);
    const statuses = events.filter(
      (e): e is Extract<LiveEvent, { type: 'status' }> => e.type === 'status',
    );
    expect(statuses.at(-1)?.run.steps).toBe(2);
  });

  it('redacts secret values out of forwarded chunks', () => {
    const bus = new LiveBus(createRedactor({ secrets: ['ops_TOPSECRET'] }));
    register(bus);
    const { events, fn } = collect();
    bus.subscribeTurn('r1', fn);
    bus.publishTurnChunk(
      'r1',
      chunk({ type: 'text-delta', id: 'a', delta: 'token ops_TOPSECRET end' }),
    );
    const last = events.at(-1);
    expect(last?.type).toBe('chunk');
    expect(JSON.stringify(last)).toContain('[REDACTED]');
    expect(JSON.stringify(last)).not.toContain('ops_TOPSECRET');
  });
});

describe('LiveBus — lifecycle', () => {
  it('marks a run finished, emits done, and carries final steps/usage', () => {
    const bus = new LiveBus(createRedactor());
    register(bus);
    const { events, fn } = collect();
    bus.subscribeTurn('r1', fn);
    bus.finishTurn('r1', 'finished', {
      steps: 3,
      usage: { in: 10, out: 5, cached: 2, cacheWrite: 1 },
    });

    expect(events.some((e) => e.type === 'done')).toBe(true);
    const run = bus.getTurn('r1');
    expect(run).toMatchObject({ status: 'finished', steps: 3, usage: { in: 10, out: 5 } });
    expect(bus.activeTurns().map((r) => r.runId)).toContain('r1'); // kept briefly for settle
  });

  it('replays a done event to a subscriber that joins after completion', () => {
    const bus = new LiveBus(createRedactor());
    register(bus);
    bus.finishTurn('r1', 'errored');
    const { events, fn } = collect();
    bus.subscribeTurn('r1', fn);
    expect(events.map((e) => e.type)).toEqual(['status', 'done']);
  });

  it('is inert for unknown runs (no throw, no subscribers)', () => {
    const bus = new LiveBus(createRedactor());
    expect(() => bus.publishTurnChunk('missing', chunk({ type: 'start-step' }))).not.toThrow();
    const unsub = bus.subscribeTurn('missing', () => {
      throw new Error('should not be called');
    });
    expect(bus.getTurn('missing')).toBeNull();
    expect(() => unsub()).not.toThrow();
  });
});
