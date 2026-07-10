import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { desc, eq, sql } from 'drizzle-orm';
import { advance, CliError, compact, digest, IDLE_MARKER } from './dream.js';
import { dreamState, messages, threadCompactions } from '../db/schema.js';
import { ConversationStore } from '../gateway/store.js';
import { createTestDb, type TestDb } from '../../tests/db.js';
import { makeConfig } from '../../tests/factories.js';

/**
 * `sunny dream` against real Postgres semantics (PGlite): the digest span, the compact
 * refusal matrix (the correctness-critical validations), supersede ordering, and the
 * watermark advance.
 */
describe('sunny dream (integration, PGlite)', () => {
  const NOW = new Date('2026-07-09T12:00:00Z');
  const THREAD = 'sendblue:owner:dm';
  let tdb: TestDb;
  let config: ReturnType<typeof makeConfig>;

  beforeEach(async () => {
    tdb = await createTestDb();
    config = makeConfig();
  });
  afterEach(async () => {
    await tdb.teardown();
  });

  /** Minutes BEFORE `NOW` (so rows default to safely older than the freshness margin). */
  const at = (minAgo: number) => new Date(NOW.getTime() - minAgo * 60_000);

  async function insert(over: {
    messageId: string;
    createdAt: Date;
    threadId?: string;
    role?: string;
    text?: string;
    payload?: unknown;
    answered?: boolean;
  }) {
    await tdb.db.insert(messages).values({
      channel: 'imessage',
      threadId: over.threadId ?? THREAD,
      messageId: over.messageId,
      role: over.role ?? 'user',
      senderId: '+15551230000',
      senderName: over.role === 'assistant' ? 'Sunny' : 'Devon',
      text: over.text ?? `text of ${over.messageId}`,
      payload: over.payload ?? null,
      isOwner: true,
      timestamp: over.createdAt,
      createdAt: over.createdAt,
      processedAt: (over.answered ?? true) ? over.createdAt : null,
    });
  }

  describe('dream digest', () => {
    it('is IDLE with nothing new since the watermark', async () => {
      await insert({ messageId: 'old', createdAt: at(600) });
      await advance(tdb.db, { threadId: THREAD, messageId: 'old' });
      expect(await digest(tdb.db, config, NOW)).toContain(IDLE_MARKER);
    });

    it('covers exactly the unprocessed span: after the watermark, older than the margin, no subagent inboxes', async () => {
      await insert({ messageId: 'covered', createdAt: at(600) });
      await insert({ messageId: 'new-1', createdAt: at(300), text: 'plan the trip' });
      await insert({ messageId: 'fresh', createdAt: at(5), text: 'too fresh to digest' });
      await insert({
        messageId: 'internal',
        createdAt: at(300),
        threadId: 'subagent:xyz',
        text: 'child chatter',
      });
      await advance(tdb.db, { threadId: THREAD, messageId: 'covered' });

      const out = await digest(tdb.db, config, NOW);
      expect(out).toContain('[id:new-1]');
      expect(out).toContain('plan the trip');
      expect(out).not.toContain('text of covered'); // the already-covered row's content is absent
      expect(out).not.toContain('too fresh');
      expect(out).not.toContain('subagent:xyz');
      // The printed advance command targets the newest included row.
      expect(out).toContain(`dream advance --thread '${THREAD}' --message 'new-1'`);
    });

    it('caps oldest-first with a PARTIAL covered-through before the newest message', async () => {
      const small = makeConfig({
        dream: { marginMinutes: 30, digestMaxChars: 700, summaryMaxChars: 6000 },
      });
      for (let i = 0; i < 10; i++) {
        await insert({ messageId: `m${i}`, createdAt: at(500 - i), text: 'x'.repeat(300) });
      }
      const out = await digest(tdb.db, small, NOW);
      expect(out).toContain('PARTIAL');
      expect(out).toContain('[id:m0]'); // oldest covered first
      expect(out).not.toContain(`--message 'm9'`); // covered-through is NOT the newest row
    });

    it("shows a thread's prior compaction summary as fold-forward context", async () => {
      await insert({ messageId: 'a', createdAt: at(500) });
      await insert({ messageId: 'b', createdAt: at(400) });
      await compact(
        tdb.db,
        config,
        {
          threadId: THREAD,
          boundaryMessageId: 'a',
          summary: 'earlier: taxes filed',
        },
        NOW,
      );
      const out = await digest(tdb.db, config, NOW);
      expect(out).toContain('earlier: taxes filed');
    });
  });

  describe('dream compact — the refusal matrix', () => {
    beforeEach(async () => {
      await insert({ messageId: 'u1', createdAt: at(500) });
      await insert({ messageId: 'a1', createdAt: at(490), role: 'assistant' });
      await insert({ messageId: 'u2', createdAt: at(400) });
      await insert({ messageId: 'a2', createdAt: at(390), role: 'assistant' });
    });

    const doCompact = (over: Partial<Parameters<typeof compact>[2]> = {}) =>
      compact(
        tdb.db,
        config,
        { threadId: THREAD, boundaryMessageId: 'a1', summary: 'covered so far', ...over },
        NOW,
      );

    it('refuses an internal subagent thread', async () => {
      await expect(doCompact({ threadId: 'subagent:x' })).rejects.toThrow(
        /internal subagent inbox/,
      );
    });

    it('refuses a boundary row that does not exist in the thread', async () => {
      await expect(doCompact({ boundaryMessageId: 'nope' })).rejects.toThrow(/no message with id/);
    });

    it('refuses a boundary newer than the freshness margin', async () => {
      await insert({ messageId: 'recent', createdAt: at(5), role: 'assistant' });
      await expect(doCompact({ boundaryMessageId: 'recent' })).rejects.toThrow(/freshness margin/);
    });

    it('refuses when an unanswered user message is at-or-before the boundary (the hot-loop guard)', async () => {
      await insert({ messageId: 'pending', createdAt: at(495), answered: false });
      await expect(doCompact()).rejects.toThrow(/unanswered user message/);
      // …but a boundary BEFORE the unanswered row is fine.
      await expect(doCompact({ boundaryMessageId: 'u1' })).resolves.toContain('ok: compacted');
    });

    it('refuses a non-monotonic (backward) boundary', async () => {
      await doCompact({ boundaryMessageId: 'a2', summary: 'through a2' });
      await expect(doCompact({ boundaryMessageId: 'a1' })).rejects.toThrow(/only moves forward/);
    });

    it('refuses a summary over the length cap and an empty one', async () => {
      await expect(doCompact({ summary: 'x'.repeat(6001) })).rejects.toThrow(/over the 6000 cap/);
      await expect(doCompact({ summary: '   ' })).rejects.toThrow(/empty/);
      expect((await doCompact({ summary: 'x'.repeat(6000) })).startsWith('ok:')).toBe(true);
    });

    it('valid write inserts; a later compact supersedes (latest per thread wins)', async () => {
      await doCompact({ boundaryMessageId: 'a1', summary: 'first' });
      await doCompact({ boundaryMessageId: 'a2', summary: 'second' });
      const rows = await tdb.db
        .select()
        .from(threadCompactions)
        .where(eq(threadCompactions.threadId, THREAD))
        .orderBy(desc(threadCompactions.seq));
      expect(rows).toHaveLength(2); // prior rows retained for audit
      expect(rows[0]!.summary).toBe('second');
      expect(rows[0]!.boundaryMessageId).toBe('a2');
    });

    it('re-compacting AT the current watermark is allowed (summary correction)', async () => {
      await doCompact({ boundaryMessageId: 'a1', summary: 'sloppy' });
      await expect(doCompact({ boundaryMessageId: 'a1', summary: 'corrected' })).resolves.toContain(
        'ok: compacted',
      );
    });

    it('failures are CliError (non-zero, model-actionable)', async () => {
      await expect(doCompact({ boundaryMessageId: 'nope' })).rejects.toBeInstanceOf(CliError);
    });
  });

  describe('microsecond precision (regression — 2026-07-10 sanity run)', () => {
    // Real rows get `defaultNow()` timestamps with MICROSECONDS; a JS Date only holds
    // milliseconds. Watermark/boundary tuples are copied + compared in SQL precisely so
    // the covered row never leaks back into the digest span or the window tail.
    async function insertReal(messageId: string, role: string, hoursAgo: number) {
      await tdb.db.insert(messages).values({
        channel: 'imessage',
        threadId: THREAD,
        messageId,
        role,
        senderId: '+15551230000',
        text: `text of ${messageId}`,
        isOwner: true,
        timestamp: new Date(),
        createdAt: sql`now() - make_interval(hours => ${hoursAgo}) + '0.000123 seconds'::interval`,
        processedAt: new Date(),
      });
    }

    it('digest is IDLE after advancing to a row with sub-millisecond precision', async () => {
      await insertReal('u1', 'user', 5);
      await insertReal('a1', 'assistant', 4);
      await advance(tdb.db, { threadId: THREAD, messageId: 'a1' });
      expect(await digest(tdb.db, config)).toContain(IDLE_MARKER);
    });

    it('the window tail excludes a sub-millisecond boundary row exactly', async () => {
      await insertReal('u1', 'user', 5);
      await insertReal('a1', 'assistant', 4);
      await insertReal('u2', 'user', 3);
      await compact(tdb.db, config, {
        threadId: THREAD,
        boundaryMessageId: 'a1',
        summary: 'covered u1+a1',
      });
      const store = new ConversationStore(tdb.db, 30);
      const win = await store.recentWindow(THREAD);
      expect(win.map((m) => m.messageId)).toEqual(['u2']);
    });
  });

  describe('dream advance', () => {
    it('upserts the global watermark and moves it forward', async () => {
      await insert({ messageId: 'w1', createdAt: at(500) });
      await insert({ messageId: 'w2', createdAt: at(400) });
      await advance(tdb.db, { threadId: THREAD, messageId: 'w1' });
      await advance(tdb.db, { threadId: THREAD, messageId: 'w2' });
      const [state] = await tdb.db.select().from(dreamState);
      expect(state?.coveredThroughMessageId).toBe('w2');
    });

    it('refuses moving backward and an unknown row', async () => {
      await insert({ messageId: 'w1', createdAt: at(500) });
      await insert({ messageId: 'w2', createdAt: at(400) });
      await advance(tdb.db, { threadId: THREAD, messageId: 'w2' });
      await expect(advance(tdb.db, { threadId: THREAD, messageId: 'w1' })).rejects.toThrow(
        /only moves forward/,
      );
      await expect(advance(tdb.db, { threadId: THREAD, messageId: 'zzz' })).rejects.toThrow(
        /no message with id/,
      );
    });
  });
});
