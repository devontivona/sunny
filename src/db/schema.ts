import { boolean, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * The message archive (durable-execution D-DE4, agent-memory keyword recall).
 * Sunny's self-owned conversation store (D-MG2) — every inbound and outbound
 * message. A generated `text_search` tsvector column + GIN index are added in a
 * follow-up SQL migration (drizzle can't express generated tsvector columns).
 */
export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    channel: text('channel').notNull(),
    threadId: text('thread_id').notNull(),
    /** Transport message id (inbound) or our send id (outbound) — for dedup. */
    messageId: text('message_id').notNull(),
    role: text('role').notNull(), // 'user' | 'assistant'
    senderId: text('sender_id').notNull(),
    senderName: text('sender_name'),
    text: text('text').notNull(),
    isOwner: boolean('is_owner').notNull().default(false),
    timestamp: timestamp('timestamp', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Recent-window reads: by thread, newest first.
    index('messages_thread_idx').on(t.threadId, t.timestamp),
  ],
);

export type MessageRow = typeof messages.$inferSelect;
export type NewMessageRow = typeof messages.$inferInsert;
