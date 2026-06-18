import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConversationStore } from '../src/gateway/store.js';
import { TurnDispatcher } from '../src/agent/dispatcher.js';
import type { ChannelEvent } from '../src/gateway/types.js';
import { createTestDb, type TestDb } from './db.js';
import { makeChannelEvent } from './factories.js';

/**
 * Runtime restart recovery (task 5.7 / D-DE1). On startup the runtime feeds every
 * un-`processedAt` inbound back through the dispatcher; an already-processed one
 * is not re-enqueued.
 */
describe('restart recovery', () => {
  let tdb: TestDb;
  let store: ConversationStore;

  beforeEach(async () => {
    tdb = await createTestDb();
    store = new ConversationStore(tdb.db, 30);
  });
  afterEach(async () => {
    await tdb.teardown();
  });

  it('re-enqueues only un-answered inbound on startup', async () => {
    // Two inbound arrived pre-crash; one got answered (processed), one didn't.
    await store.appendInbound(makeChannelEvent({ messageId: 'answered', text: 'old, done' }));
    await store.appendInbound(makeChannelEvent({ messageId: 'pending', text: 'never answered' }));
    await store.markProcessed('imessage', 'answered');

    // Simulate the runtime's recovery wiring.
    const recovered: string[] = [];
    const dispatcher = new TurnDispatcher(
      async (e: ChannelEvent) => void recovered.push(e.messageId),
      store,
    );
    for (const ev of await store.findUnprocessedInbound()) dispatcher.enqueue(ev);
    await new Promise((r) => setTimeout(r, 0));

    expect(recovered).toEqual(['pending']);
  });

  it('marks a recovered message processed after its turn, so a second recovery is a no-op', async () => {
    await store.appendInbound(makeChannelEvent({ messageId: 'pending', text: 'answer me' }));

    const dispatcher = new TurnDispatcher(async () => {}, store);
    for (const ev of await store.findUnprocessedInbound()) dispatcher.enqueue(ev);
    await new Promise((r) => setTimeout(r, 0));

    expect(await store.findUnprocessedInbound()).toHaveLength(0); // now marked processed
  });
});
