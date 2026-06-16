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

/**
 * Persisted schedules (scheduling D-SC1/2). The table is the source of truth —
 * a ~60s ticker dispatches due rows as Tier-2 durable jobs. Survives restarts.
 */
export const schedules = pgTable(
  'schedules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: text('kind').notNull(), // 'once' | 'interval' | 'cron'
    spec: text('spec').notNull(), // ISO timestamp | duration (e.g. '2h') | cron expr
    prompt: text('prompt').notNull(), // what Sunny should do when it fires
    threadId: text('thread_id').notNull(), // delivery target (default: owner DM)
    timezone: text('timezone').notNull(),
    label: text('label'),
    nextRunAt: timestamp('next_run_at', { withTimezone: true }),
    active: boolean('active').notNull().default(true),
    lastRunAt: timestamp('last_run_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('schedules_due_idx').on(t.active, t.nextRunAt)],
);

/** Run history for schedules (scheduling D-SC5: retained for inspection). */
export const scheduleRuns = pgTable('schedule_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  scheduleId: uuid('schedule_id').notNull(),
  firedAt: timestamp('fired_at', { withTimezone: true }).notNull().defaultNow(),
  status: text('status').notNull(), // 'running' | 'completed' | 'failed'
  output: text('output'),
  error: text('error'),
});

export type ScheduleRow = typeof schedules.$inferSelect;
export type NewScheduleRow = typeof schedules.$inferInsert;
