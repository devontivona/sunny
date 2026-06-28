import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * The message archive (durable-execution D-DE4, agent-memory keyword recall).
 * Sunny's self-owned conversation store (D-MG2) — every inbound and outbound
 * message. A generated `text_search` tsvector column + GIN index are added in a
 * follow-up SQL migration (drizzle can't express generated tsvector columns).
 *
 * Turn-grained transcript (D-MG9): a row carries a queryable envelope (channel,
 * thread_id, message_id, role, …), the rich AI SDK `UIMessage` as a `jsonb`
 * `payload` for verbatim replay, and the flattened `text` projection that backs
 * `text_search`/recall. The payload is nullable for legacy rows written before
 * D-MG9 (the loader falls back to `text` for those).
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
    /** Flattened text projection for FTS/recall (the delivered/inbound text). */
    text: text('text').notNull(),
    /** Rich AI SDK `UIMessage` for this turn (verbatim replay); null on legacy rows (D-MG9). */
    payload: jsonb('payload'),
    isOwner: boolean('is_owner').notNull().default(false),
    timestamp: timestamp('timestamp', { withTimezone: true }).notNull(),
    /** Set when the turn for this inbound message completed (durable-execution D-DE1). */
    processedAt: timestamp('processed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Recent-window reads: by thread, newest first.
    index('messages_thread_idx').on(t.threadId, t.timestamp),
    // Idempotency / dedup: a (channel, message id) is processed at most once.
    uniqueIndex('messages_channel_msgid_uniq').on(t.channel, t.messageId),
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
    /** Output target for the fired run (durable-subagents D-DS1): 'user' | 'silent'. A `silent`
     *  schedule records its result but sends no proactive message (e.g. nightly consolidation). */
    outputTarget: text('output_target').notNull().default('user'),
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

/**
 * Web-dashboard authentication store (web-dashboard D-WD4). The dashboard runs as
 * a separate process but shares this Postgres; these are the ONLY tables it
 * writes. Everything else it touches (messages, schedules, memory files) is
 * read-only. Sessions are server-side + revocable; access requests are the
 * iMessage-approval device-pairing handshake.
 */

/** An issued, revocable browser session (httpOnly signed cookie carries the id). */
export const dashboardSessions = pgTable(
  'dashboard_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Coarse device hint captured at issuance (user-agent + IP/time). */
    deviceHint: text('device_hint'),
    revoked: boolean('revoked').notNull().default(false),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('dashboard_sessions_expiry_idx').on(t.revoked, t.expiresAt)],
);

/**
 * A pending device-pairing request. The owner approves by tapping a one-time
 * link (carrying `secret`) delivered to their DM; the requesting browser (bound
 * by a pending cookie) then exchanges the approved request for a session. Status
 * default-denies on timeout.
 */
export const accessRequests = pgTable(
  'access_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** One-time approval secret; only ever delivered to the owner's DM. */
    secret: text('secret').notNull(),
    deviceHint: text('device_hint'),
    status: text('status').notNull().default('pending'), // 'pending' | 'approved' | 'denied' | 'expired' | 'consumed'
    /** The session minted when the approved request is exchanged (one-time). */
    sessionId: uuid('session_id'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('access_requests_status_idx').on(t.status, t.expiresAt)],
);

export type DashboardSessionRow = typeof dashboardSessions.$inferSelect;
export type AccessRequestRow = typeof accessRequests.$inferSelect;
