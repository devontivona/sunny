import { describe, expect, it } from 'vitest';
import { TurnDispatcher, type RunTurn } from './dispatcher.js';
import type { ConversationStore } from '../gateway/store.js';
import type { ChannelEvent } from '../gateway/types.js';
import { makeChannelEvent } from '../../tests/factories.js';

/** Stub store: records markProcessed order; that's all the dispatcher touches. */
class StubStore {
  readonly processed: string[] = [];
  markProcessed(_channel: string, messageId: string): Promise<void> {
    this.processed.push(messageId);
    return Promise.resolve();
  }
}

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/** Let queued microtasks + the async run loop settle. */
const flush = () => new Promise((r) => setTimeout(r, 0));

function makeDispatcher(runTurn: RunTurn) {
  const store = new StubStore();
  const dispatcher = new TurnDispatcher(runTurn, store as unknown as ConversationStore);
  return { dispatcher, store };
}

describe('TurnDispatcher', () => {
  it('dedups a message already enqueued this session', async () => {
    const calls: string[] = [];
    const { dispatcher } = makeDispatcher(async (e) => void calls.push(e.messageId));
    const ev = makeChannelEvent({ messageId: 'm1' });
    dispatcher.enqueue(ev);
    dispatcher.enqueue(ev);
    await flush();
    expect(calls).toEqual(['m1']);
  });

  it('serializes same-thread messages — a mid-run arrival does not start a competing run', async () => {
    const calls: string[] = [];
    const gate = deferred();
    const { dispatcher, store } = makeDispatcher(async (e) => {
      calls.push(e.messageId);
      if (e.messageId === 'm1') await gate.promise;
    });
    const T = 'sendblue:owner:contact';
    dispatcher.enqueue(makeChannelEvent({ threadId: T, messageId: 'm1' }));
    await flush();
    expect(calls).toEqual(['m1']); // running, blocked

    dispatcher.enqueue(makeChannelEvent({ threadId: T, messageId: 'm2' }));
    await flush();
    expect(calls).toEqual(['m1']); // m2 queued, NOT a second concurrent run

    gate.resolve();
    await flush();
    expect(calls).toEqual(['m1', 'm2']); // m2 ran as a follow-up turn
    expect(store.processed).toEqual(['m1', 'm2']); // mark-done order preserved
  });

  it('folds a mid-run arrival into the in-flight turn when it drains', async () => {
    const calls: string[] = [];
    let drained: ChannelEvent[] = [];
    const gate = deferred();
    const { dispatcher, store } = makeDispatcher(async (e, steer) => {
      calls.push(e.messageId);
      if (e.messageId === 'm1') {
        await gate.promise;
        drained = steer.drain();
      }
    });
    const T = 'sendblue:owner:contact';
    dispatcher.enqueue(makeChannelEvent({ threadId: T, messageId: 'm1' }));
    await flush();
    dispatcher.enqueue(makeChannelEvent({ threadId: T, messageId: 'm2' }));
    await flush();
    gate.resolve();
    await flush();

    expect(drained.map((e) => e.messageId)).toEqual(['m2']); // folded into m1's run
    expect(calls).toEqual(['m1']); // m2 was NOT run as its own turn
    expect(store.processed).toEqual(['m1', 'm2']); // both still marked done
  });

  it('runs different threads concurrently', async () => {
    const started: string[] = [];
    const gate = deferred();
    const { dispatcher } = makeDispatcher(async (e) => {
      started.push(e.threadId);
      await gate.promise;
    });
    dispatcher.enqueue(makeChannelEvent({ threadId: 'sendblue:owner:a', messageId: 'a1' }));
    dispatcher.enqueue(makeChannelEvent({ threadId: 'sendblue:owner:b', messageId: 'b1' }));
    await flush();
    expect(started.sort()).toEqual(['sendblue:owner:a', 'sendblue:owner:b']);
    gate.resolve();
    await flush();
  });

  it('evicts the oldest seen entries past SEEN_CAP so an old id can run again', async () => {
    const calls: string[] = [];
    const { dispatcher } = makeDispatcher(async (e) => void calls.push(e.messageId));
    const CAP = 5000;
    for (let i = 0; i < CAP + 1; i++) {
      dispatcher.enqueue(
        makeChannelEvent({ threadId: `sendblue:owner:t${i}`, messageId: `m-${i}` }),
      );
    }
    await flush();
    expect(calls).toHaveLength(CAP + 1);

    // m-0 was among the oldest ~10% evicted → it runs again.
    dispatcher.enqueue(makeChannelEvent({ threadId: 'sendblue:owner:t0', messageId: 'm-0' }));
    // The most recent id is still in `seen` → deduped.
    dispatcher.enqueue(
      makeChannelEvent({ threadId: `sendblue:owner:t${CAP}`, messageId: `m-${CAP}` }),
    );
    await flush();
    expect(calls.filter((m) => m === 'm-0')).toHaveLength(2);
    expect(calls.filter((m) => m === `m-${CAP}`)).toHaveLength(1);
  });
});
