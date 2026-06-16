import { desc, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { Db } from '../db/client.js';
import { messages } from '../db/schema.js';
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
  timestamp: Date;
  isOwner: boolean;
}

export class ConversationStore {
  constructor(
    private readonly db: Db,
    private readonly windowSize: number,
  ) {}

  /** Persist an inbound (user) message. */
  async appendInbound(event: ChannelEvent): Promise<void> {
    await this.db.insert(messages).values({
      channel: event.channel,
      threadId: event.threadId,
      messageId: event.messageId,
      role: 'user',
      senderId: event.senderId,
      senderName: event.senderName ?? null,
      text: event.text,
      isOwner: event.isOwner,
      timestamp: event.timestamp,
    });
  }

  /** Persist an outbound (assistant) message Sunny sent via `send_message`. */
  async appendOutbound(
    threadId: string,
    messageId: string,
    text: string,
    channel = 'imessage',
  ): Promise<void> {
    await this.db.insert(messages).values({
      channel,
      threadId,
      messageId: messageId || randomUUID(),
      role: 'assistant',
      senderId: 'sunny',
      senderName: 'Sunny',
      text,
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
    timestamp: row.timestamp,
    isOwner: row.isOwner,
  };
}
