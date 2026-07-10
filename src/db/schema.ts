import {
  bigserial,
  boolean,
  index,
  integer,
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
    /** Optional explicit audience (run-audiences #4: cross-person scheduling). When set (e.g.
     *  `person:Kate`), the fired run is for/delivered to that party regardless of the creating
     *  thread — so the owner can schedule a reminder FOR a family member. When null, the audience
     *  is derived from `threadId` + `outputTarget` (the common per-person case). */
    audience: text('audience'),
    /** The grants the fired run is endowed ({ audience, authority } — tool-access spec; D-RA5).
     *  Attenuated against the creating turn's authority at creation. Null (legacy rows / default)
     *  → the memory-maintenance default (memory tools + message). */
    authority: text('authority').array(),
    timezone: text('timezone').notNull(),
    label: text('label'),
    nextRunAt: timestamp('next_run_at', { withTimezone: true }),
    active: boolean('active').notNull().default(true),
    lastRunAt: timestamp('last_run_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('schedules_due_idx').on(t.active, t.nextRunAt)],
);

/**
 * Outbound delivery tracking (delivery-status-tracking, 2026-07-07). One row per tracked
 * text send, keyed by Sendblue's `message_handle` — the async status callback's correlation
 * key. Sendblue's REST 2xx only means "accepted"; the real outcome (DELIVERED vs
 * ERROR/INTERNAL_ERROR) arrives later on the webhook, which previously nobody consumed —
 * a failed send left the turn recorded `delivered: 'text'` while the person got nothing
 * (the Kate phantom-send incidents, Jul 05 + Jul 07). `message_handle` is re-keyed to the
 * newest handle on each retry, so one row tracks a logical message across resends.
 */
export const outboundDeliveries = pgTable(
  'outbound_deliveries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    messageHandle: text('message_handle').notNull(),
    threadId: text('thread_id').notNull(),
    text: text('text').notNull(),
    /** 'sent' (awaiting status) | 'delivered' | 'retrying' (resend in flight) | 'failed'. */
    status: text('status').notNull().default('sent'),
    /** Sends performed for this logical message (initial send = 1). */
    attempts: integer('attempts').notNull().default(1),
    /** The most recent raw Sendblue status seen (observability). */
    lastStatus: text('last_status'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('outbound_deliveries_handle_idx').on(t.messageHandle)],
);

export type OutboundDeliveryRow = typeof outboundDeliveries.$inferSelect;

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

/**
 * Durable parent↔child delegation links (durable-subagents D-DS2/D-DS6/D-DS8). One row per
 * delegated child run: who spawned it (`parentThreadId` — where the child's reports are
 * delivered), the child's own inbox thread (`childThreadId` — where parent→child steers land),
 * the run id (filled once started), lifecycle `status`, spawn `depth` (the anti-blowup cap), and
 * whether the child may itself delegate (`orchestrator`). Survives restart, so the supervisor can
 * re-attach its watchdog to in-flight children and enforce concurrency from the durable record,
 * not just in-memory state.
 */
export const subagentLinks = pgTable(
  'subagent_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** The spawning run's inbox thread — where this child's reports/failures are delivered. */
    parentThreadId: text('parent_thread_id').notNull(),
    /** The child's own inbox thread (D-DS12) — where parent→child steers land. Unique per child. */
    childThreadId: text('child_thread_id').notNull(),
    /** The WDK run id of the child, set once started (null briefly between insert and start). */
    childRunId: text('child_run_id'),
    /** The brief the child was given (for inspection). */
    task: text('task').notNull(),
    /** 'running' | 'done' | 'failed' | 'timeout' (D-DS6). */
    status: text('status').notNull().default('running'),
    /** Spawn depth (D-DS8): top-level children are depth 1; an orchestrator child's children 2… */
    depth: integer('depth').notNull().default(1),
    /** Whether this child may itself delegate (D-DS8: no sub-delegation unless an orchestrator). */
    orchestrator: boolean('orchestrator').notNull().default(false),
    /** Model id the child runs on (D-DS9), for inspection. */
    model: text('model'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('subagent_links_child_thread_uniq').on(t.childThreadId),
    // Concurrency/active-children lookups: by parent, by status.
    index('subagent_links_parent_idx').on(t.parentThreadId, t.status),
  ],
);

export type SubagentLinkRow = typeof subagentLinks.$inferSelect;
export type NewSubagentLinkRow = typeof subagentLinks.$inferInsert;

/**
 * Per-thread compaction summaries (context-lifecycle). Written by the dreaming job via
 * `sunny dream compact` (which owns the validations), read by window assembly as a
 * READ-TIME OVERLAY: [latest summary] + [verbatim rows strictly after the boundary].
 * Raw message rows are never deleted or mutated. The boundary is the `(created_at,
 * message_id)` tuple of a stored row — the SAME ordering `recentWindow` uses, so the
 * covered/replayed split is exact (no overlap, no gap). The latest row per thread wins
 * (`seq` — strict insert order); prior rows are retained for audit.
 */
export const threadCompactions = pgTable(
  'thread_compactions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Strict insert order — "latest per thread" without createdAt tie ambiguity. */
    seq: bigserial('seq', { mode: 'number' }).notNull(),
    threadId: text('thread_id').notNull(),
    /** Boundary watermark: the covered-through row's `created_at`… */
    boundaryCreatedAt: timestamp('boundary_created_at', { withTimezone: true }).notNull(),
    /** …and `message_id` (the tuple tiebreaker, matching `recentWindow`'s ordering). */
    boundaryMessageId: text('boundary_message_id').notNull(),
    /** The summary replayed as the window's head (content contract in skill:dreaming). */
    summary: text('summary').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('thread_compactions_thread_idx').on(t.threadId, t.seq)],
);

export type ThreadCompactionRow = typeof threadCompactions.$inferSelect;

/**
 * The GLOBAL dreaming watermark (context-lifecycle): how far the digest has processed,
 * advanced only at the END of a successful dream (`sunny dream advance`) so a failed
 * dream reprocesses its span. Deliberately independent of per-thread compaction
 * boundaries — the dream may decline to compact a quiet thread yet must still memorize
 * its content exactly once. A single row (id 'global'), upserted.
 */
export const dreamState = pgTable('dream_state', {
  id: text('id').primaryKey(),
  coveredThroughCreatedAt: timestamp('covered_through_created_at', {
    withTimezone: true,
  }).notNull(),
  coveredThroughMessageId: text('covered_through_message_id').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export type DreamStateRow = typeof dreamState.$inferSelect;
