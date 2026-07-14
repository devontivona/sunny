import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { subagentLinks, type SubagentLinkRow } from '../db/schema.js';
import type { Runtime } from '../runtime.js';
import type { ChannelEvent } from '../gateway/types.js';
import { logger } from '../logger.js';

const log = logger('delegation');

/** Channel tag for messages delivered between runs (child→parent reports, parent→child steers).
 *  Internal — never a transport. The recipient's run reads by `threadId`, so the channel only
 *  has to be stable + distinct from a real transport's ids (for the dedup unique index). */
export const DELEGATION_CHANNEL = 'delegation';

export { MAX_CONCURRENT_CHILDREN, MAX_DELEGATION_DEPTH } from './limits.js';

/** A distinct internal inbox thread for a child run (D-DS12). `subagent:` is non-group
 *  (`isGroupThreadId` keys off the 3rd colon-segment), so a child runs with DM semantics. */
export function newChildThreadId(): string {
  return `subagent:${randomUUID()}`;
}

/** Whether a thread is an internal child inbox (vs. a real owner/group conversation thread). */
export function isChildThread(threadId: string): boolean {
  return threadId.startsWith('subagent:');
}

/** Make a model-supplied subagent label safe as a sender name + `Name: text` attribution prefix:
 *  no newlines/colons (which would break the speaker convention or rendering), bounded length,
 *  never empty. */
export function sanitizeLabel(label?: string): string {
  const cleaned = (label ?? '')
    .replace(/[\r\n:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40)
    .trim();
  return cleaned || 'subagent';
}

export interface CreateLinkInput {
  parentThreadId: string;
  childThreadId: string;
  task: string;
  depth: number;
  orchestrator: boolean;
  model?: string;
}

/** Insert a parent↔child link (status 'running'). */
export async function createLink(db: Db, input: CreateLinkInput): Promise<SubagentLinkRow> {
  const [row] = await db
    .insert(subagentLinks)
    .values({
      parentThreadId: input.parentThreadId,
      childThreadId: input.childThreadId,
      task: input.task,
      depth: input.depth,
      orchestrator: input.orchestrator,
      model: input.model ?? null,
      status: 'running',
    })
    .returning();
  if (!row) throw new Error('failed to create subagent link');
  return row;
}

/** Record the child's WDK run id once started. */
export async function setChildRunId(db: Db, childThreadId: string, runId: string): Promise<void> {
  await db
    .update(subagentLinks)
    .set({ childRunId: runId })
    .where(eq(subagentLinks.childThreadId, childThreadId));
}

/** Mark a link terminal (done | failed | timeout | cancelled) and stamp completion (D-DS6/D-DS7).
 *  Only transitions a **running** link — so a child that finishes AFTER `cancel_run` set it
 *  `cancelled` can't overwrite that back to `done` (the cancellation stays recorded), and a
 *  watchdog late-fire can't resurrect an already-terminal link. */
export async function completeLink(
  db: Db,
  childThreadId: string,
  status: 'done' | 'failed' | 'timeout' | 'cancelled',
): Promise<void> {
  await db
    .update(subagentLinks)
    .set({ status, completedAt: new Date() })
    .where(
      and(eq(subagentLinks.childThreadId, childThreadId), eq(subagentLinks.status, 'running')),
    );
}

/** How many of a parent's children are still running — the concurrency gate (D-DS8). */
export async function activeChildCount(db: Db, parentThreadId: string): Promise<number> {
  const rows = await db
    .select({ id: subagentLinks.id })
    .from(subagentLinks)
    .where(
      and(eq(subagentLinks.parentThreadId, parentThreadId), eq(subagentLinks.status, 'running')),
    );
  return rows.length;
}

/** All still-running links (D-DS6 restart recovery): the supervisor re-attaches a watchdog to
 *  each on startup so a child in flight across a restart can't leak a `running` link. */
export async function listRunningLinks(db: Db): Promise<SubagentLinkRow[]> {
  return db.select().from(subagentLinks).where(eq(subagentLinks.status, 'running'));
}

/** The link for a child inbox thread, or undefined (used to resolve a child's parent + depth). */
export async function getLinkByChildThread(
  db: Db,
  childThreadId: string,
): Promise<SubagentLinkRow | undefined> {
  const [row] = await db
    .select()
    .from(subagentLinks)
    .where(eq(subagentLinks.childThreadId, childThreadId));
  return row;
}

/** Min interface the inter-run messaging needs — `ConversationStore.appendInbound`. Keeps the
 *  low-level append usable from both the workflow step (full runtime) and the in-process
 *  supervisor (store only), without dragging the whole `Runtime` type into the latter. */
export interface InboundSink {
  appendInbound(event: ChannelEvent): Promise<boolean>;
}

/**
 * Deliver a message from one run into another run's inbox thread (durable-subagents D-DS4) — a
 * child→parent report, a parent→child steer, or a watchdog failure event. The recipient's run
 * folds it via `loadSteers`; the recipient is just another thread in the store, there is no hook.
 * Returns whether it was newly inserted (deduped on replay by the channel+messageId unique index).
 */
export async function appendInterRunMessage(
  store: InboundSink,
  threadId: string,
  from: { id: string; name: string },
  text: string,
): Promise<boolean> {
  const event: ChannelEvent = {
    channel: DELEGATION_CHANNEL,
    threadId,
    messageId: randomUUID(),
    senderId: from.id,
    senderName: from.name,
    text,
    attachments: [],
    timestamp: new Date(),
    isGroup: false,
    isOwner: false,
  };
  return store.appendInbound(event);
}

/** The report's origin lane, named in its attribution so the relay turn (and recorded
 *  history) can tell a delegated child from a fired schedule (unified-voice-layer D-VL2). */
export type ReportLane = 'subagent' | 'scheduled';

/**
 * Worker → conversation report (D-DS4; unified-voice-layer D-VL1): deliver `text` into the
 * recipient run's inbox thread, then wake the thread's run-supply so an idle conversation is
 * restarted as the mediating relay turn (an in-flight one folds it via `loadSteers`). Used by
 * both a child reporting to its parent AND a scheduled run reporting to its audience's
 * conversation loop. Runs inside `emitStep`'s `'use step'`, so it's memoized on replay.
 */
export async function reportToParent(
  runtime: Runtime,
  out: { threadId: string; fromId?: string; fromName?: string },
  text: string,
  lane: ReportLane = 'subagent',
): Promise<void> {
  const name = sanitizeLabel(out.fromName);
  // Attribute the report so the recipient reads it as a message from a NAMED worker, not from the
  // owner — the inbox can be the owner's own DM thread (D-DS12), where a bare report would
  // be indistinguishable from the owner speaking. `Name: text` is the same speaker convention the
  // model already follows in group threads, so no DM-specific rendering is needed; `sanitizeLabel`
  // keeps a model-supplied label from breaking that convention (no embedded newline/colon).
  const attributed = `${name} (${lane}): ${text}`;
  const inserted = await appendInterRunMessage(
    runtime.store,
    out.threadId,
    { id: out.fromId ?? 'subagent', name },
    attributed,
  );
  if (!inserted) return;
  // Wake the parent's run-supply ONLY for a real conversation thread. A `subagent:` parent inbox
  // (an orchestrator child — future) is a single run, not router-driven, so waking it would wrongly
  // start a conversation turn on an internal thread; an in-flight orchestrator folds the report via
  // `loadSteers`, a finished one is run-to-completion (no re-drive).
  if (!isChildThread(out.threadId)) runtime.wakeThread?.(out.threadId);
  log.info('child reported to parent', { parentThread: out.threadId, from: name });
}

/**
 * Parent → child steer (D-DS4): deliver `text` into the child's own inbox thread. A child is a
 * single in-flight run (run-to-completion, D-DS7), so its `loadSteers` folds the steer at its
 * next step; no wake is needed (if the child already ended, the steer is simply a no-op). Used by
 * the `message_subagent` tool.
 */
export async function steerChild(
  db: Db,
  store: InboundSink,
  childThreadId: string,
  text: string,
): Promise<boolean> {
  // Only a STILL-RUNNING child can fold a steer (run-to-completion, D-DS7). If it already
  // finished (or is unknown), report not-delivered so the caller doesn't tell the model its
  // course-correction took effect when it was a no-op on a dead thread. (A child that finishes in
  // the gap between this check and folding is a rare, harmless dangling row — the steer just isn't
  // folded; the honest common-case result is what matters.)
  const link = await getLinkByChildThread(db, childThreadId);
  if (!link || link.status !== 'running') return false;
  await appendInterRunMessage(store, childThreadId, { id: 'parent', name: 'parent' }, text);
  log.info('parent steered child', { childThread: childThreadId });
  return true;
}
