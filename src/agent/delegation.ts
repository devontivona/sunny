import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { subagentLinks, type SubagentLinkRow } from '../db/schema.js';
import type { Runtime } from '../runtime.js';
import type { ChannelEvent } from '../gateway/types.js';
import type { EmitTarget } from './outputTarget.js';
import { logger } from '../logger.js';

const log = logger('delegation');

/** Channel tag for messages delivered between runs (child→parent reports, parent→child steers).
 *  Internal — never a transport. The recipient's run reads by `threadId`, so the channel only
 *  has to be stable + distinct from a real transport's ids (for the dedup unique index). */
export const DELEGATION_CHANNEL = 'delegation';

/** Bounded fan-out + depth (D-DS8): defaults guarded against the "depth 5 × branching 3 = 243
 *  agents" blowup. A child cannot delegate further unless it is an orchestrator. */
export const MAX_CONCURRENT_CHILDREN = 3;
export const MAX_DELEGATION_DEPTH = 2;

/** A distinct internal inbox thread for a child run (D-DS12). `subagent:` is non-group
 *  (`isGroupThreadId` keys off the 3rd colon-segment), so a child runs with DM semantics. */
export function newChildThreadId(): string {
  return `subagent:${randomUUID()}`;
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

/** Mark a link terminal (done | failed | timeout) and stamp completion (D-DS6/D-DS7). */
export async function completeLink(
  db: Db,
  childThreadId: string,
  status: 'done' | 'failed' | 'timeout',
): Promise<void> {
  await db
    .update(subagentLinks)
    .set({ status, completedAt: new Date() })
    .where(eq(subagentLinks.childThreadId, childThreadId));
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

/**
 * Child → parent report (D-DS4): deliver `text` into the parent run's inbox thread, then wake the
 * parent's run-supply so an idle parent is restarted (an in-flight parent folds it via
 * `loadSteers`). Runs inside `emitStep`'s `'use step'`, so it's memoized on replay.
 */
export async function reportToParent(
  runtime: Runtime,
  out: EmitTarget,
  text: string,
): Promise<void> {
  const name = out.fromName ?? 'subagent';
  const inserted = await appendInterRunMessage(
    runtime.store,
    out.destThreadId,
    { id: out.fromId ?? 'subagent', name },
    text,
  );
  if (!inserted) return;
  // Wake the parent's run-supply: an idle parent is restarted by the supervisor/router.
  runtime.wakeThread?.(out.destThreadId);
  log.info('child reported to parent', { parentThread: out.destThreadId, from: name });
}

/**
 * Parent → child steer (D-DS4): deliver `text` into the child's own inbox thread. A child is a
 * single in-flight run (run-to-completion, D-DS7), so its `loadSteers` folds the steer at its
 * next step; no wake is needed (if the child already ended, the steer is simply a no-op). Used by
 * the `message_subagent` tool.
 */
export async function steerChild(
  store: InboundSink,
  childThreadId: string,
  text: string,
): Promise<void> {
  await appendInterRunMessage(store, childThreadId, { id: 'parent', name: 'parent' }, text);
  log.info('parent steered child', { childThread: childThreadId });
}
