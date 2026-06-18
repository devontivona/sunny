import type { ConversationStore } from '../gateway/store.js';
import type { ChannelEvent } from '../gateway/types.js';
import { logger } from '../logger.js';

const log = logger('dispatcher');

/** Cap the in-session dedup set so it can't grow without bound. */
const SEEN_CAP = 5000;

/** Lets an in-flight turn pull newly-arrived messages to fold in (D-DE steering, 4.1b). */
export interface SteerHandle {
  drain(): ChannelEvent[];
}

export type RunTurn = (event: ChannelEvent, steer: SteerHandle) => Promise<void>;

interface ActiveTurn {
  steer: ChannelEvent[];
}

/**
 * Turn dispatcher (durable-execution D-DE1, tasks 4.1/4.1b).
 *
 * - **Ack-fast**: `enqueue` returns immediately; the turn runs in the background
 *   (the gateway can return the webhook 200 right away).
 * - **Per-thread serialization** (R7): one turn at a time per thread; rapid
 *   messages on a thread don't race.
 * - **Double-text steering** (R12): a message arriving while a thread's turn is
 *   in flight folds into that run (drained by the agent's `prepareStep`) instead
 *   of starting a competing run.
 * - **Mark-processed**: each handled message is marked done so restart recovery
 *   re-runs only the un-answered ones.
 */
export class TurnDispatcher {
  private readonly active = new Map<string, ActiveTurn>();
  private readonly seen = new Set<string>();

  constructor(
    private readonly runTurn: RunTurn,
    private readonly store: ConversationStore,
  ) {}

  enqueue(event: ChannelEvent): void {
    const key = `${event.channel}:${event.messageId}`;
    if (this.seen.has(key)) return; // already enqueued this session
    this.seen.add(key);
    if (this.seen.size > SEEN_CAP) {
      // FIFO-evict the oldest ~10% (Set preserves insertion order).
      for (const k of [...this.seen].slice(0, SEEN_CAP / 10)) this.seen.delete(k);
    }

    const active = this.active.get(event.threadId);
    if (active) {
      // A run is in flight for this thread → steer it; don't start a new run.
      active.steer.push(event);
      log.info('steering in-flight turn', { threadId: event.threadId, messageId: event.messageId });
      return;
    }
    void this.runThread(event).catch((err) =>
      log.error('turn loop crashed', { threadId: event.threadId, err: String(err) }),
    );
  }

  private async runThread(first: ChannelEvent): Promise<void> {
    const tid = first.threadId;
    const state: ActiveTurn = { steer: [] };
    this.active.set(tid, state);
    try {
      let current: ChannelEvent | undefined = first;
      while (current) {
        const folded: ChannelEvent[] = [];
        const handle: SteerHandle = {
          drain: () => {
            const d = state.steer.splice(0);
            folded.push(...d);
            return d;
          },
        };
        try {
          await this.runTurn(current, handle);
        } catch (err) {
          log.error('turn failed', {
            threadId: tid,
            messageId: current.messageId,
            err: String(err),
          });
        }
        await this.markDone(current);
        for (const f of folded) await this.markDone(f);

        // Messages that arrived after the last step (not drained) become the next
        // turn — synchronous from here to the loop check, so none can be lost.
        const leftover = state.steer.splice(0);
        current = leftover.shift();
        if (current) state.steer.unshift(...leftover);
      }
    } finally {
      this.active.delete(tid);
    }
  }

  private async markDone(event: ChannelEvent): Promise<void> {
    try {
      await this.store.markProcessed(event.channel, event.messageId);
    } catch (err) {
      log.warn('markProcessed failed', { messageId: event.messageId, err: String(err) });
    }
  }
}
