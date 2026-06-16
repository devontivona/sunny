import type { ChannelEvent } from './types.js';

/**
 * Trivial in-memory conversation store (messaging-gateway D-MG2, task 2.3).
 *
 * Sunny owns its own conversation history; the transport provides none. This
 * skeleton keeps a bounded recent window per thread in memory — promoted to
 * Postgres (with tsvector FTS recall for older messages) in Phase 2. The
 * interface is intentionally small so the Postgres store is a drop-in.
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
  private readonly threads = new Map<string, StoredMessage[]>();

  constructor(private readonly windowSize: number) {}

  /** Persist an inbound (user) message. */
  appendInbound(event: ChannelEvent): StoredMessage {
    const msg: StoredMessage = {
      messageId: event.messageId,
      threadId: event.threadId,
      role: 'user',
      senderId: event.senderId,
      senderName: event.senderName,
      text: event.text,
      timestamp: event.timestamp,
      isOwner: event.isOwner,
    };
    this.append(msg);
    return msg;
  }

  /** Persist an outbound (assistant) message Sunny sent via `send_message`. */
  appendOutbound(threadId: string, messageId: string, text: string): StoredMessage {
    const msg: StoredMessage = {
      messageId,
      threadId,
      role: 'assistant',
      senderId: 'sunny',
      senderName: 'Sunny',
      text,
      timestamp: new Date(),
      isOwner: false,
    };
    this.append(msg);
    return msg;
  }

  /** Return the recent window for a thread, oldest-first. */
  recentWindow(threadId: string): StoredMessage[] {
    return this.threads.get(threadId) ?? [];
  }

  private append(msg: StoredMessage): void {
    const list = this.threads.get(msg.threadId) ?? [];
    list.push(msg);
    // Bound the window; older messages fall out (recall for those is Phase 2).
    if (list.length > this.windowSize) list.splice(0, list.length - this.windowSize);
    this.threads.set(msg.threadId, list);
  }
}
