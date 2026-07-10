import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConversationStore } from './store.js';
import { messages, threadCompactions } from '../db/schema.js';
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

  describe('write-boundary sanitization (poison-content hardening)', () => {
    // PGlite is real Postgres, so it rejects NUL / lone surrogates in text+jsonb exactly
    // like prod — without the store's sanitizer these inserts throw "null character not
    // permitted", which is what left a turn unpersisted and re-delivered (the dup-reply bug).
    it('appendTurn persists a payload/text carrying NUL bytes instead of failing', async () => {
      const poison = 'Got the PDF \u0000\u0000 %PDF-1.6 binary \uD800 tail';
      const payload = { id: 'turn', role: 'assistant', parts: [{ type: 'text', text: poison }] };
      await expect(store.appendTurn(OWNER_THREAD, payload, poison)).resolves.toBeUndefined();
      const win = await store.recentWindow(OWNER_THREAD);
      expect(win).toHaveLength(1);
      expect(win[0]!.text).not.toContain('\u0000');
      expect(win[0]!.text).toContain('Got the PDF');
      expect(JSON.stringify(win[0]!.payload)).not.toContain('\\u0000');
    });

    it('appendInbound sanitizes NUL bytes in inbound text', async () => {
      const ev = makeChannelEvent({ messageId: 'nul-1', text: 'hi\u0000there' });
      await expect(store.appendInbound(ev)).resolves.toBe(true);
      const win = await store.recentWindow(ev.threadId);
      expect(win[0]!.text).toBe('hithere');
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

  describe('inbound media refs + recovery (messaging-media D-MM1/2)', () => {
    const ref = {
      path: '/m/inbound/m1/0.jpg',
      mediaType: 'image/jpeg',
      kind: 'image' as const,
      name: 'photo.jpg',
      size: 1234,
      direction: 'inbound' as const,
    };

    it('references persisted attachments in the stored user payload', async () => {
      await store.appendInbound(makeChannelEvent({ messageId: 'm1', text: 'look' }), [ref]);
      const [row] = await store.recentWindow(OWNER_THREAD);
      const payload = row!.payload as { parts: Array<{ type: string; data?: typeof ref }> };
      const att = payload.parts.find((p) => p.type === 'data-attachment');
      expect(att?.data).toEqual(ref);
      // The bytes are NOT in the payload — only a disk reference.
      expect(JSON.stringify(payload)).not.toContain('base64');
    });

    it('repopulates event.attachments from the payload on recovery (not [])', async () => {
      await store.appendInbound(makeChannelEvent({ messageId: 'm2', text: 'see this' }), [ref]);
      const [ev] = await store.findUnprocessedInbound();
      expect(ev?.attachments).toHaveLength(1);
      expect(ev?.attachments[0]).toMatchObject({
        filename: 'photo.jpg',
        mimeType: 'image/jpeg',
        kind: 'image',
        size: 1234,
      });
      // Already on disk — nothing to re-fetch from an expired URL.
      expect(ev?.attachments[0]?.fetchData).toBeUndefined();
    });
  });

  describe('recall v2 — snippets + tool-text projection (context-lifecycle)', () => {
    it('finds facts that live only in the tool-result extract of a turn projection', async () => {
      const filler = Array.from({ length: 200 }, (_, i) => `word${i}`).join(' ');
      const projection = `checked your statements\n[tool results]\n[bash] ${filler} the invoice total was zylophant dollars ${filler}`;
      await store.appendTurn(OWNER_THREAD, { id: 't', role: 'assistant', parts: [] }, projection);
      const hits = await store.recall('zylophant');
      expect(hits).toHaveLength(1);
    });

    it('returns a headline snippet, not the whole stored row', async () => {
      const filler = Array.from({ length: 500 }, (_, i) => `word${i}`).join(' ');
      const projection = `ok\n[tool results]\n[bash] ${filler} unique zylophant fact ${filler}`;
      await store.appendTurn(OWNER_THREAD, { id: 't', role: 'assistant', parts: [] }, projection);
      const [hit] = await store.recall('zylophant');
      expect(hit!.snippet).toContain('«zylophant»');
      expect(hit!.snippet.length).toBeLessThan(500);
      expect(hit!.snippet.length).toBeLessThan(hit!.text.length);
    });

    it('messageById deep-fetches one row (and null for an unknown id)', async () => {
      await store.appendInbound(makeChannelEvent({ messageId: 'deep-1', text: 'deep fetch me' }));
      const row = await store.messageById('deep-1');
      expect(row?.text).toBe('deep fetch me');
      expect(await store.messageById('nope')).toBeNull();
    });
  });

  describe('compaction-aware window (context-lifecycle 4.1)', () => {
    /** Insert a message row with an explicit createdAt so tuple ordering is controllable. */
    async function insertAt(messageId: string, createdAt: Date, text = messageId) {
      await tdb.db.insert(messages).values({
        channel: 'imessage',
        threadId: OWNER_THREAD,
        messageId,
        role: 'user',
        senderId: '+15551230000',
        text,
        isOwner: true,
        timestamp: createdAt,
        createdAt,
      });
    }

    async function compactAt(messageId: string, createdAt: Date, summary = 'summary') {
      await tdb.db.insert(threadCompactions).values({
        threadId: OWNER_THREAD,
        boundaryCreatedAt: createdAt,
        boundaryMessageId: messageId,
        summary,
      });
    }

    const t = (s: number) => new Date(Date.UTC(2026, 6, 1, 0, 0, s));

    it('legacy fallback: with no compaction row the fixed-size window is unchanged', async () => {
      const small = new ConversationStore(tdb.db, 2, 120);
      for (let i = 0; i < 3; i++) await insertAt(`m${i}`, t(i));
      const win = await small.recentWindow(OWNER_THREAD);
      expect(win.map((m) => m.messageId)).toEqual(['m1', 'm2']);
    });

    it('boundary exclusion: only rows strictly after the watermark tuple replay', async () => {
      for (let i = 0; i < 4; i++) await insertAt(`m${i}`, t(i));
      await compactAt('m1', t(1));
      const win = await store.recentWindow(OWNER_THREAD);
      expect(win.map((m) => m.messageId)).toEqual(['m2', 'm3']);
    });

    it('tuple tie: a createdAt tie is broken by messageId, same as the ordering', async () => {
      await insertAt('m-a', t(5));
      await insertAt('m-b', t(5)); // same instant — tuple (t5, 'm-b') > (t5, 'm-a')
      await compactAt('m-a', t(5));
      const win = await store.recentWindow(OWNER_THREAD);
      expect(win.map((m) => m.messageId)).toEqual(['m-b']);
    });

    it('cap overflow: the post-watermark tail keeps the newest compactedWindowMaxRows', async () => {
      const capped = new ConversationStore(tdb.db, 30, 2);
      for (let i = 0; i < 5; i++) await insertAt(`m${i}`, t(i));
      await compactAt('m0', t(0));
      const win = await capped.recentWindow(OWNER_THREAD);
      expect(win.map((m) => m.messageId)).toEqual(['m3', 'm4']); // oldest uncompacted fell off
    });

    it('latestCompaction returns the newest row per thread (supersede by seq)', async () => {
      for (let i = 0; i < 3; i++) await insertAt(`m${i}`, t(i));
      await compactAt('m0', t(0), 'first');
      await compactAt('m1', t(1), 'second');
      const latest = await store.latestCompaction(OWNER_THREAD);
      expect(latest?.summary).toBe('second');
      expect(latest?.boundaryMessageId).toBe('m1');
      expect(await store.latestCompaction('sendblue:other:thread')).toBeNull();
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

    it('R10: is idempotent on a durable-step retry — same (channel, messageId) does not throw, one row', async () => {
      // A durable step that re-runs on replay can re-insert the same outbound row; like
      // appendInbound, that must be a no-op, not a unique-constraint violation.
      await store.appendOutbound(OWNER_THREAD, 'out-dup', 'retried delivery');
      await expect(
        store.appendOutbound(OWNER_THREAD, 'out-dup', 'retried delivery'),
      ).resolves.toBeUndefined();
      const win = await store.recentWindow(OWNER_THREAD);
      expect(win.filter((m) => m.role === 'assistant')).toHaveLength(1);
    });
  });
});
