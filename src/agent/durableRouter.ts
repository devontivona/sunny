import { getRun, start } from 'workflow/api';
import type { UIMessageChunk } from 'ai';
import { createModelCallToUIChunkTransform, type ModelCallStreamPart } from '@ai-sdk/workflow';
import { runConversation } from '../../workflows/conversation.js';
import type { ChannelEvent, Gateway } from '../gateway/types.js';
import type { ConversationStore } from '../gateway/store.js';
import { isGroupThreadId } from '../gateway/threadId.js';
import { getLiveBus } from '../observability/live.js';
import { logger } from '../logger.js';

const log = logger('durable-router');

/** Re-fire typing at most this often per thread while a turn streams. */
const TYPING_THROTTLE_MS = 4000;
/** Suppress typing for this long after a delivery so it doesn't reappear during a turn's
 *  post-send housekeeping (the model's wrap-up step still emits chunks after the last send). */
const TYPING_POST_SEND_COOLDOWN_MS = 6000;

/**
 * Durable Tier-1 router (durable-main-loop), the gateway-side counterpart of the per-turn
 * durable conversational run. Gated behind `SUNNY_DURABLE_TURNS=1`.
 *
 * ONE run = ONE turn. This router provides what the keep-alive hook used to (and what caused
 * the turns-2+ parking bug): per-thread serialization + "start the next turn when there's
 * unanswered inbound". A per-thread serial WORKER starts a turn-run, awaits its completion,
 * and loops while the store still shows unanswered inbound — so a thread's turns never race
 * and a message that lands mid-turn is answered (folded into the active run via the store, or
 * as the very next turn-run). It also bridges each turn-run's WDK output stream into the
 * in-process LiveBus, so the dashboard's existing live pane renders durable turns exactly like
 * the in-process ones — no dashboard changes, the live-pane code is reused, not duplicated.
 */
export class DurableTurnRouter {
  /** Threads whose serial worker is currently running. */
  private readonly processing = new Set<string>();
  /** Threads that received inbound while their worker was finishing (re-check signal). */
  private readonly dirty = new Set<string>();
  private readonly lastTyped = new Map<string, number>();

  constructor(
    private readonly gateway: Gateway,
    private readonly store: ConversationStore,
    private readonly meta: { modelId: string; effort: string | null },
  ) {}

  /** Route one inbound (already persisted + deduped by the gateway): ensure this thread's
   *  serial worker is draining its unanswered inbound as durable turn-runs. */
  route(event: ChannelEvent): void {
    this.ensureWorker(event.threadId);
  }

  /**
   * Wake a thread's run-supply (durable-subagents D-DS13): ensure a serial worker is draining it.
   * The runtime exposes this as `wakeThread` so a `'use step'` can nudge the router after writing
   * to a thread's inbox out-of-band — e.g. a child reporting to its parent (the parent thread is a
   * normal conversation thread this router already drives), or the watchdog delivering a failure.
   */
  wake(threadId: string): void {
    this.ensureWorker(threadId);
  }

  /** Re-drive any inbound that was received but never answered (durable-main-loop D5): on
   *  startup, ensure a worker runs for each affected thread. The worker reads the store, so a
   *  message that landed while the gateway was down is answered. */
  async recoverPending(events: ChannelEvent[]): Promise<void> {
    const seen = new Set<string>();
    for (const event of events) {
      if (seen.has(event.threadId)) continue;
      seen.add(event.threadId);
      this.ensureWorker(event.threadId);
    }
  }

  private ensureWorker(threadId: string): void {
    this.dirty.add(threadId); // mark "there may be work"
    if (this.processing.has(threadId)) return; // a worker is already (or about to be) draining
    this.processing.add(threadId);
    void this.work(threadId);
  }

  private async work(threadId: string): Promise<void> {
    try {
      for (;;) {
        this.dirty.delete(threadId);
        while (await this.store.hasUnansweredInbound(threadId)) {
          await this.runTurn(threadId);
        }
        // Sync check-clear (NO await between): an inbound that set `dirty` either landed
        // before this check (→ loop again) or after we clear `processing` (→ `ensureWorker`
        // spawns a fresh worker). So no wakeup is ever lost to the check/clear gap.
        if (!this.dirty.has(threadId)) {
          this.processing.delete(threadId);
          return;
        }
      }
    } catch (err) {
      this.processing.delete(threadId);
      log.error('conversation worker crashed', { threadId, err: String(err) });
    }
  }

  /** Run ONE durable turn for a thread and await its completion. */
  private async runTurn(threadId: string): Promise<void> {
    let runId: string | undefined;
    try {
      const run = await start(runConversation, [{ threadId }]);
      runId = run.runId;
      this.bridgeRunStream(runId, threadId);
      await run.returnValue; // durable: resolves when the turn (incl. its delivery step) is done
    } catch (err) {
      log.error('conversation turn-run failed', { threadId, runId, err: String(err) });
    }
  }

  /**
   * Tail a turn-run's WDK output stream once: (1) refresh the typing indicator (throttled,
   * suppressed for a beat after a delivery), and (2) bridge its chunks into the in-process
   * LiveBus so the dashboard's conversation live pane can render the turn. Registers the run as
   * a 'turn' (so the Conversation page's thread subscription picks it up) and settles it when the
   * stream closes. (The LiveBus also tracks which run is a thread's active turn for the
   * dashboard's active-runs snapshot — a thread→run map the bare WDK stream doesn't provide.)
   */
  private bridgeRunStream(runId: string, threadId: string): void {
    const bus = getLiveBus();
    bus.registerTurn({
      runId,
      threadId,
      label: isGroupThreadId(threadId) ? 'Group' : 'Conversation',
      model: this.meta.modelId,
      effort: this.meta.effort,
    });
    void (async () => {
      let reader: ReadableStreamDefaultReader<UIMessageChunk> | null = null;
      try {
        // The run stream carries raw model-call parts (v7 WorkflowAgent writable); convert to
        // UIMessageChunk here at the reader boundary (the transform can't run in the workflow sandbox).
        reader = getRun<unknown>(runId)
          .getReadable<ModelCallStreamPart>()
          .pipeThrough(createModelCallToUIChunkTransform())
          .getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          bus.publishTurnChunk(runId, value);
          const now = Date.now();
          // Don't show typing right after a delivery (post-send wrap-up chunks).
          if (now - (this.gateway.lastSentAt?.(threadId) ?? 0) < TYPING_POST_SEND_COOLDOWN_MS) {
            continue;
          }
          if (now - (this.lastTyped.get(threadId) ?? 0) >= TYPING_THROTTLE_MS) {
            this.lastTyped.set(threadId, now);
            await this.gateway.startTyping(threadId).catch(() => {});
          }
        }
      } catch (err) {
        log.debug('run stream bridge ended', { runId, threadId, err: String(err) });
      } finally {
        await reader?.cancel().catch(() => {});
        let status: 'finished' | 'errored' = 'finished';
        try {
          status = (await getRun<unknown>(runId).status) === 'failed' ? 'errored' : 'finished';
        } catch {
          /* keep optimistic 'finished' */
        }
        bus.finishTurn(runId, status);
      }
    })();
  }
}
