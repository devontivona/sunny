import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConversationStore } from './store.js';
import { createTestDb, type TestDb } from '../../tests/db.js';
import { makeChannelEvent, OWNER_THREAD } from '../../tests/factories.js';

describe('ConversationStore (integration, PGlite)', () => {
  let tdb: TestDb;
  let store: ConversationStore;

  beforeEach(async () => {
    tdb = await createTestDb();
    store = new ConversationStore(tdb.db, 30);
  });
  afterEach(async () => {
    await tdb.teardown();
  });

  describe('appendInbound dedup (5.2)', () => {
    it('inserts once and treats a same (channel, messageId) retry as a no-op', async () => {
      const ev = makeChannelEvent({ messageId: 'dup-1', text: 'hello' });
      expect(await store.appendInbound(ev)).toBe(true);
      expect(await store.appendInbound(ev)).toBe(false); // onConflictDoNothing
      const win = await store.recentWindow(ev.threadId);
      expect(win).toHaveLength(1);
    });
  });

  describe('recentWindow order + limit (5.2)', () => {
    it('returns the newest `windowSize` messages, oldest-first', async () => {
      const small = new ConversationStore(tdb.db, 2);
      for (const text of ['first', 'second', 'third']) {
        await small.appendInbound(makeChannelEvent({ messageId: text, text }));
      }
      const win = await small.recentWindow(OWNER_THREAD);
      expect(win.map((m) => m.text)).toEqual(['second', 'third']); // last 2, oldest-first
    });

    it('scopes the window to one thread', async () => {
      await store.appendInbound(makeChannelEvent({ threadId: 'sendblue:owner:a', messageId: 'a' }));
      await store.appendInbound(makeChannelEvent({ threadId: 'sendblue:owner:b', messageId: 'b' }));
      expect(await store.recentWindow('sendblue:owner:a')).toHaveLength(1);
    });
  });

  describe('markProcessed / findUnprocessedInbound (5.2)', () => {
    it('reports only un-processed inbound, in arrival order, then clears them', async () => {
      await store.appendInbound(makeChannelEvent({ messageId: 'p1', text: 'one' }));
      await store.appendInbound(makeChannelEvent({ messageId: 'p2', text: 'two' }));
      let pending = await store.findUnprocessedInbound();
      expect(pending.map((e) => e.messageId)).toEqual(['p1', 'p2']);

      await store.markProcessed('imessage', 'p1');
      pending = await store.findUnprocessedInbound();
      expect(pending.map((e) => e.messageId)).toEqual(['p2']);
    });

    it('reconstructs isOwner / isGroup on recovered events', async () => {
      await store.appendInbound(
        makeChannelEvent({
          threadId: 'sendblue:owner:g:grp',
          messageId: 'g1',
          isGroup: true,
          isOwner: false,
        }),
      );
      const [ev] = await store.findUnprocessedInbound();
      expect(ev?.isGroup).toBe(true);
      expect(ev?.isOwner).toBe(false);
    });
  });

  describe('recall — tsvector/FTS keyword search (5.3)', () => {
    beforeEach(async () => {
      await store.appendInbound(
        makeChannelEvent({ messageId: 'r1', text: 'I love hiking in the mountains' }),
      );
      await store.appendInbound(
        makeChannelEvent({ messageId: 'r2', text: 'The foxes were running fast' }),
      );
      await store.appendInbound(
        makeChannelEvent({ messageId: 'r3', text: 'Dinner reservation at 7pm' }),
      );
    });

    it('matches with English stemming (foxes → fox, running → run)', async () => {
      expect((await store.recall('fox')).map((m) => m.messageId)).toEqual(['r2']);
      expect((await store.recall('run')).map((m) => m.messageId)).toEqual(['r2']);
    });

    it('returns nothing for an absent term and for an empty query', async () => {
      expect(await store.recall('spaceship')).toEqual([]);
      expect(await store.recall('   ')).toEqual([]);
    });

    it('respects the limit', async () => {
      await store.appendInbound(makeChannelEvent({ messageId: 'r4', text: 'mountains again' }));
      expect(await store.recall('mountains', 1)).toHaveLength(1);
    });
  });

  describe('appendOutbound — proactive / Tier-2 send (5.6)', () => {
    it('writes a standalone assistant row with the assistantSendPayload shape', async () => {
      await store.appendOutbound(OWNER_THREAD, 'out-1', 'your job finished');
      const win = await store.recentWindow(OWNER_THREAD);
      expect(win).toHaveLength(1);
      const row = win[0]!;
      expect(row.role).toBe('assistant');
      expect(row.text).toBe('your job finished');
      const payload = row.payload as { parts: Array<{ type: string; input?: { text?: string } }> };
      expect(payload.parts[0]?.type).toBe('tool-send_message');
      expect(payload.parts[0]?.input?.text).toBe('your job finished');
    });
  });
});
