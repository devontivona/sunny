import { randomUUID } from 'node:crypto';
import type { Runtime } from '../runtime.js';
import type { ChannelEvent } from '../gateway/types.js';
import type { EmitTarget } from './outputTarget.js';
import { logger } from '../logger.js';

const log = logger('delegation');

/** Channel tag for messages delivered between runs (child→parent reports, parent→child steers).
 *  Internal — never a transport. The recipient's run reads by `threadId`, so the channel only
 *  has to be stable + distinct from a real transport's ids (for the dedup unique index). */
export const DELEGATION_CHANNEL = 'delegation';

/**
 * Child → parent report (durable-subagents D-DS4): deliver `text` into the parent run's inbox
 * thread as an inbound the parent's next run folds via `loadSteers`, then wake the parent's
 * run-supply so an idle parent is restarted. The recipient is just another thread in the store;
 * there is no hook. Runs inside `emitStep`'s `'use step'`, so it's memoized on replay.
 */
export async function reportToParent(
  runtime: Runtime,
  out: EmitTarget,
  text: string,
): Promise<void> {
  const event: ChannelEvent = {
    channel: DELEGATION_CHANNEL,
    threadId: out.destThreadId,
    messageId: randomUUID(),
    senderId: out.fromId ?? 'subagent',
    senderName: out.fromName ?? 'subagent',
    text,
    attachments: [],
    timestamp: new Date(),
    isGroup: false,
    isOwner: false,
  };
  const inserted = await runtime.store.appendInbound(event);
  if (!inserted) return;
  // Wake the parent's run-supply: an in-flight parent folds this via loadSteers at its next
  // step; an idle parent is restarted by the supervisor. `wakeThread` is a no-op until the
  // supervisor is wired (it is reached only by `parent`-targeted children, which require it).
  runtime.wakeThread?.(out.destThreadId);
  log.info('child reported to parent', { parentThread: out.destThreadId, from: event.senderName });
}
