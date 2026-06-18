import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { Db } from '../db/client.js';
import { messages } from '../db/schema.js';
import { isGroupThreadId } from './threadId.js';
import type { ChannelEvent } from './types.js';

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

/** Inbound user message as a `UIMessage` (D-MG9) — one text part, raw text. */
function userPayload(event: ChannelEvent): unknown {
  return {
    id: event.messageId,
    role: 'user',
    parts: [{ type: 'text', text: event.text }],
    metadata: { createdAt: event.timestamp.toISOString() },
  };
}

/**
 * A standalone outbound send (proactive / Tier-2) as a `UIMessage` (D-MG9).
 * Represented as a `send_message` tool call so it reads the same as a
 * conversational send in history (reinforces "speaking == send_message").
 */
function assistantSendPayload(id: string, text: string): unknown {
  return {
    id,
    role: 'assistant',
    parts: [
      {
        type: 'tool-send_message',
        toolCallId: `send-${id}`,
        state: 'output-available',
        input: { text },
        output: 'delivered',
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
  async appendInbound(event: ChannelEvent): Promise<boolean> {
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
        payload: userPayload(event),
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
      attachments: [],
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
      payload: assistantSendPayload(id, text),
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
      .orderBy(desc(messages.createdAt))
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
