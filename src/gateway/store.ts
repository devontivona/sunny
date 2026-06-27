import { and, asc, desc, eq, inArray, isNull, notInArray, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { Db } from '../db/client.js';
import { messages } from '../db/schema.js';
import { attachmentRefsOf, type AttachmentRef, type OutboundMediaResult } from './media.js';
import { isGroupThreadId } from './threadId.js';
import type { Attachment, ChannelEvent } from './types.js';

/**
 * Sunny's self-owned conversation store (messaging-gateway D-MG2), backed by
 * Postgres (durable-execution D-DE4). Holds a durable archive of every inbound
 * and outbound message; the agent reads a bounded recent window verbatim and
 * recalls older history by full-text keyword search (agent-memory: keyword
 * recall). Promoted from the Phase-1 in-memory store.
 */
export interface StoredMessage {
  messageId: string;
  threadId: string;
  role: 'user' | 'assistant';
  senderId: string;
  senderName?: string;
  text: string;
  /** Rich AI SDK `UIMessage` for this turn (D-MG9); null on legacy rows. */
  payload: unknown;
  timestamp: Date;
  isOwner: boolean;
}

/**
 * Inbound user message as a `UIMessage` (D-MG9): one text part plus a
 * `data-attachment` part per persisted attachment (D-MM1). The parts carry only
 * a disk REFERENCE, never the bytes — so history replay re-reads from disk
 * instead of re-billing the bytes as tokens or re-fetching an expired URL.
 */
function userPayload(event: ChannelEvent, refs: AttachmentRef[]): unknown {
  return {
    id: event.messageId,
    role: 'user',
    parts: [
      { type: 'text', text: event.text },
      ...refs.map((ref, i) => ({
        type: 'data-attachment',
        id: `${event.messageId}-${i}`,
        data: ref,
      })),
    ],
    metadata: { createdAt: event.timestamp.toISOString() },
  };
}

/**
 * A standalone outbound send (proactive / Tier-2) as a `UIMessage` (D-MG9).
 * Represented as a `send_message` tool call so it reads the same as a
 * conversational send in history (reinforces "speaking == send_message").
 */
function assistantSendPayload(id: string, text: string, media?: OutboundMediaResult): unknown {
  return {
    id,
    role: 'assistant',
    parts: [
      {
        type: 'tool-send_message',
        toolCallId: `send-${id}`,
        state: 'output-available',
        input: { text, ...(media && 'url' in media ? { image: media.url } : {}) },
        // The tool output carries the durable/external media ref (D-MM5/9) so the
        // dashboard can render a standalone send's image (D-MM9).
        output: media ? { status: 'delivered', media } : 'delivered',
      },
    ],
    metadata: { createdAt: new Date().toISOString() },
  };
}

export class ConversationStore {
  constructor(
    private readonly db: Db,
    private readonly windowSize: number,
  ) {}

  /**
   * Persist an inbound (user) message. Returns `true` if newly inserted, `false`
   * if it was a duplicate (same channel + message id) — i.e. a webhook retry
   * (durable-execution D-DE1: inbound dedup).
   */
  async appendInbound(event: ChannelEvent, refs: AttachmentRef[] = []): Promise<boolean> {
    const inserted = await this.db
      .insert(messages)
      .values({
        channel: event.channel,
        threadId: event.threadId,
        messageId: event.messageId,
        role: 'user',
        senderId: event.senderId,
        senderName: event.senderName ?? null,
        text: event.text,
        payload: userPayload(event, refs),
        isOwner: event.isOwner,
        timestamp: event.timestamp,
      })
      .onConflictDoNothing({ target: [messages.channel, messages.messageId] })
      .returning({ id: messages.id });
    return inserted.length > 0;
  }

  /** Mark an inbound message's turn as completed (durable-execution D-DE1). */
  async markProcessed(channel: string, messageId: string): Promise<void> {
    await this.db
      .update(messages)
      .set({ processedAt: new Date() })
      .where(and(eq(messages.channel, channel), eq(messages.messageId, messageId)));
  }

  /**
   * Mark a precise set of inbound messages processed in one statement (durable-main-loop
   * D5). The durable conversational run marks exactly the user messages it answered this
   * turn — the window it read plus any steers folded mid-turn — so a message that lands in
   * the gap between answering and marking stays unprocessed and is picked up next turn
   * (rather than being marked answered when it wasn't). A no-op on an empty id list.
   */
  async markProcessedMany(channel: string, messageIds: string[]): Promise<void> {
    if (messageIds.length === 0) return;
    await this.db
      .update(messages)
      .set({ processedAt: new Date() })
      .where(and(eq(messages.channel, channel), inArray(messages.messageId, messageIds)));
  }

  /**
   * Mark a thread's inbound messages answered — scoped by `threadId` (which is channel-specific),
   * so it works for ANY channel without the caller knowing the channel. Used by the durable turn,
   * whose `messageIds` already come from thread-scoped reads (`windowUserIds`/`unansweredSteers`).
   * (`hasUnansweredInbound` keys off `threadId` only, so a channel-mismatched mark leaves the
   * message perpetually unanswered → a re-run loop; this avoids that.) A no-op on an empty list.
   */
  async markAnsweredForThread(threadId: string, messageIds: string[]): Promise<void> {
    if (messageIds.length === 0) return;
    await this.db
      .update(messages)
      .set({ processedAt: new Date() })
      .where(and(eq(messages.threadId, threadId), inArray(messages.messageId, messageIds)));
  }

  /**
   * Whether this thread has any inbound (user) message still awaiting a reply
   * (durable-main-loop D5). The durable per-thread run uses this as its idempotency
   * gate: it answers the window only while unanswered inbound exists, so a hook
   * wake that carries nothing new (e.g. a steer already folded into the prior turn)
   * does not trigger a redundant turn.
   */
  async hasUnansweredInbound(threadId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: messages.messageId })
      .from(messages)
      .where(
        and(
          eq(messages.threadId, threadId),
          eq(messages.role, 'user'),
          isNull(messages.processedAt),
        ),
      )
      .limit(1);
    return !!row;
  }

  /**
   * Unanswered (unprocessed) user messages on a thread, EXCLUDING a given set of ids,
   * oldest-first (durable-main-loop, mid-turn steering). The durable run calls this from
   * `prepareStep` to fold messages that arrived MID-TURN into the in-flight turn's next
   * model step — passing the turn's already-in-prompt window ids + already-folded ids as
   * `excludeIds`, so only genuinely new arrivals come back. Reading from the store (the
   * durable source of truth the gateway persists to on arrival) keeps folding deterministic
   * inside a `'use step'` and avoids a concurrent hook consumer (which would race the
   * between-turn `await hook`). Capped at the window size.
   */
  async unansweredSteers(
    threadId: string,
    excludeIds: string[],
  ): Promise<{ messageId: string; text: string; senderName?: string }[]> {
    const conds = [
      eq(messages.threadId, threadId),
      eq(messages.role, 'user'),
      isNull(messages.processedAt),
    ];
    if (excludeIds.length > 0) conds.push(notInArray(messages.messageId, excludeIds));
    const rows = await this.db
      .select({
        messageId: messages.messageId,
        text: messages.text,
        senderName: messages.senderName,
      })
      .from(messages)
      .where(and(...conds))
      .orderBy(asc(messages.createdAt))
      .limit(this.windowSize);
    return rows.map((r) => ({
      messageId: r.messageId,
      text: r.text,
      senderName: r.senderName ?? undefined,
    }));
  }

  /** The message ids of this thread's recent window, oldest-first (durable-main-loop
   *  D5) — the user-message ids the durable run marks processed after answering. */
  async windowUserIds(threadId: string): Promise<string[]> {
    const rows = await this.db
      .select({ messageId: messages.messageId, role: messages.role })
      .from(messages)
      .where(eq(messages.threadId, threadId))
      .orderBy(desc(messages.createdAt))
      .limit(this.windowSize);
    return rows.filter((r) => r.role === 'user').map((r) => r.messageId);
  }

  /**
   * Inbound messages received but never marked processed (e.g. the process died
   * mid-turn). Re-run on startup so a reboot-before-reply still gets answered.
   */
  async findUnprocessedInbound(): Promise<ChannelEvent[]> {
    const rows = await this.db
      .select()
      .from(messages)
      .where(and(eq(messages.role, 'user'), isNull(messages.processedAt)))
      .orderBy(asc(messages.createdAt));
    return rows.map((r) => ({
      channel: r.channel,
      threadId: r.threadId,
      messageId: r.messageId,
      senderId: r.senderId,
      senderName: r.senderName ?? undefined,
      text: r.text,
      // Reconstruct attachments from the persisted payload refs (D-MM1/2): the
      // bytes are already on disk, so the replayed event reflects them rather
      // than dropping them to []. fetchData is omitted — nothing to re-fetch.
      attachments: refToAttachment(r.payload),
      timestamp: r.timestamp,
      isGroup: isGroupThreadId(r.threadId),
      isOwner: r.isOwner,
    }));
  }

  /**
   * Persist a standalone outbound (assistant) message — proactive sends and
   * Tier-2 job/scheduled deliveries. Conversational turns use `appendTurn`
   * instead (one row per turn; D-MG9).
   */
  async appendOutbound(
    threadId: string,
    messageId: string,
    text: string,
    channel = 'imessage',
    media?: OutboundMediaResult,
  ): Promise<void> {
    const id = messageId || randomUUID();
    await this.db.insert(messages).values({
      channel,
      threadId,
      messageId: id,
      role: 'assistant',
      senderId: 'sunny',
      senderName: 'Sunny',
      text,
      payload: assistantSendPayload(id, text, media),
      isOwner: false,
      timestamp: new Date(),
    });
  }

  /**
   * Persist one conversational assistant turn as a single row (D-MG9): the rich
   * `UIMessage` `payload` (scratch + all tool parts incl. every `send_message`)
   * for verbatim replay, plus the flattened `text` projection for recall.
   */
  async appendTurn(
    threadId: string,
    payload: unknown,
    text: string,
    channel = 'imessage',
  ): Promise<void> {
    await this.db.insert(messages).values({
      channel,
      threadId,
      messageId: randomUUID(),
      role: 'assistant',
      senderId: 'sunny',
      senderName: 'Sunny',
      text,
      payload,
      isOwner: false,
      timestamp: new Date(),
    });
  }

  /** Return the recent window for a thread, oldest-first. */
  async recentWindow(threadId: string): Promise<StoredMessage[]> {
    const rows = await this.db
      .select()
      .from(messages)
      .where(eq(messages.threadId, threadId))
      // `createdAt` (defaultNow) can TIE when rows insert in the same instant (rapid inserts on a
      // fast machine — flaked CI), and ties order arbitrarily. `messageId` is a stable secondary
      // key so the window is deterministic. (For real traffic createdAt rarely ties; on a tie the
      // two are effectively simultaneous, so any stable order is fine.)
      .orderBy(desc(messages.createdAt), desc(messages.messageId))
      .limit(this.windowSize);
    return rows.reverse().map(toStored);
  }

  /**
   * Keyword recall over the full archive (agent-memory: keyword recall, D5
   * upgrade path). Full-text match via the GIN-indexed tsvector. The recall
   * *interface* is intentionally search-by-query so a `pgvector` semantic
   * implementation can slot in later without agent-loop changes (3.6).
   */
  async recall(query: string, limit = 10): Promise<StoredMessage[]> {
    if (!query.trim()) return [];
    const rows = await this.db
      .select()
      .from(messages)
      .where(sql`"text_search" @@ plainto_tsquery('english', ${query})`)
      .orderBy(desc(messages.timestamp))
      .limit(limit);
    return rows.map(toStored);
  }
}

/** Rebuild normalized attachments (metadata only) from a stored payload's refs. */
function refToAttachment(payload: unknown): Attachment[] {
  return attachmentRefsOf(payload).map((ref, i) => ({
    id: `${i}`,
    filename: ref.name,
    mimeType: ref.mediaType,
    size: ref.size,
    kind: ref.kind,
  }));
}

function toStored(row: typeof messages.$inferSelect): StoredMessage {
  return {
    messageId: row.messageId,
    threadId: row.threadId,
    role: row.role as 'user' | 'assistant',
    senderId: row.senderId,
    senderName: row.senderName ?? undefined,
    text: row.text,
    payload: row.payload ?? null,
    timestamp: row.timestamp,
    isOwner: row.isOwner,
  };
}
