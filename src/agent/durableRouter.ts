import { getRun, start } from 'workflow/api';
import type { UIMessageChunk } from 'ai';
import { createModelCallToUIChunkTransform, type ModelCallStreamPart } from '@ai-sdk/workflow';
import { runConversation } from '../../workflows/conversation.js';
import type { ChannelEvent, Gateway } from '../gateway/types.js';
import type { ConversationStore } from '../gateway/store.js';
import { isGroupThreadId } from '../gateway/threadId.js';
import { getLiveBus } from '../observability/live.js';
import { raceTurnWatchdog, TurnWatchdogTimeout } from './turnWatchdog.js';
import { logger } from '../logger.js';

const log = logger('durable-router');

/** Re-fire typing at most this often per thread while a turn streams (before its first send). */
const TYPING_THROTTLE_MS = 4000;

/** A started turn-run, as the router sees it (the injectable slice of WDK's `Run`). */
export interface TurnRunHandle {
  runId: string;
  returnValue: Promise<unknown>;
  /** Cancel the run in the WDK world (terminal `run_cancelled` event). */
  cancel: () => Promise<void>;
}

/** Start one durable turn-run for a thread. Injectable so tests can drive the router
 *  (incl. the watchdog's abandon path) without a WDK world; production uses {@link
 *  startConversationRun}. */
export type TurnRunner = (threadId: string) => Promise<TurnRunHandle>;

/** The production runner: a real `runConversation` run in the WDK world. */
const startConversationRun: TurnRunner = async (threadId) => {
  const run = await start(runConversation, [{ threadId }]);
  return { runId: run.runId, returnValue: run.returnValue, cancel: () => run.cancel() };
};

/** The user-facing note when the watchdog abandons a hung turn (design choice: an explicit,
 *  observable failure instead of a silent re-run — see {@link DurableTurnRouter.abandonHungTurn}).
 *  Two wordings: whether the hung turn already delivered something this turn. */
const WATCHDOG_NOTE_NOTHING_SENT =
  'Sorry — that one got stuck on my end and I had to give up on it. Mind sending it again?';
const WATCHDOG_NOTE_PARTIAL =
  'Sorry — I got stuck partway through that and had to stop. Nudge me if you were still waiting on something.';

/**
 * Durable Tier-1 router (durable-main-loop), the gateway-side counterpart of the per-turn
 * durable conversational run.
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
    private readonly meta: { modelId: string; effort: string | null; turnWatchdogMs: number },
    /** Test seam: how a turn-run is started (production = the real WDK run). */
    private readonly runs: TurnRunner = startConversationRun,
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

  /**
   * Adopt a run already RUNNING in the WDK world at startup (restart-orphan safety,
   * 2026-07-05 investigation): the orphan is driven through the SAME machinery as a fresh
   * turn — stream bridge (typing + live pane), watchdog, explicit abandon — inside the
   * thread's serial worker. Restart recovery for this thread then naturally queues BEHIND
   * the orphan instead of racing it on a global timeout, which is what produced a full
   * duplicate answer (the PR #29 class): the old 30s bound expired while a healthy orphan
   * still had minutes to run, and recovery started a second run for the same inbound.
   */
  adoptRun(threadId: string, run: TurnRunHandle): void {
    this.adopted.set(threadId, run);
    this.ensureWorker(threadId);
  }

  private readonly adopted = new Map<string, TurnRunHandle>();

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
        // An adopted restart-orphan runs FIRST, through the full turn machinery; only after
        // it settles (and marked its messages) does the drain below see what's left.
        const orphan = this.adopted.get(threadId);
        if (orphan) {
          this.adopted.delete(threadId);
          await this.driveTurn(threadId, orphan);
        }
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

  /** Run ONE durable turn for a thread and await its completion — bounded by the watchdog
   *  (hung-model-stream exposure): a stalled model stream must never block the thread forever. */
  private async runTurn(threadId: string): Promise<void> {
    let run: TurnRunHandle | undefined;
    try {
      run = await this.runs(threadId);
    } catch (err) {
      log.error('conversation turn-run failed to start', { threadId, err: String(err) });
      return;
    }
    await this.driveTurn(threadId, run);
  }

  /** Drive one (fresh or adopted) turn-run: stream bridge (live pane + typing), watchdog
   *  race, explicit abandon on timeout. Shared by `runTurn` and `adoptRun`. */
  private async driveTurn(threadId: string, run: TurnRunHandle): Promise<void> {
    const startedAt = Date.now();
    try {
      this.bridgeRunStream(run.runId, threadId);
      // Durable: resolves when the turn (incl. its delivery step) is done. Raced against the
      // watchdog so a hung stream costs one abandoned turn, not the whole thread.
      await raceTurnWatchdog(run.returnValue, this.meta.turnWatchdogMs);
    } catch (err) {
      if (err instanceof TurnWatchdogTimeout) {
        await this.abandonHungTurn(threadId, run, startedAt, err.timeoutMs);
      } else {
        log.error('conversation turn-run failed', {
          threadId,
          runId: run.runId,
          err: String(err),
        });
      }
    }
  }

  /**
   * The watchdog fired: the turn-run has been hung past the budget (typically a stalled model
   * stream). Recovery design — an EXPLICIT, observable failure, never a silent re-run:
   *
   *  1. CANCEL the run in the WDK world (best-effort), so a zombie that un-hangs later can't
   *     keep executing steps (late bubbles, a stale `markAnswered` racing a fresh turn).
   *  2. RETIRE the thread's unanswered inbound. This is the double-text guard (the PR #29
   *     duplicate-reply class): the worker's `hasUnansweredInbound` loop would otherwise start
   *     a FRESH run for the same messages — and a fresh run is not a replay, it re-answers from
   *     scratch, re-sending anything the hung run already delivered (its sends are memoized
   *     only within the SAME run's journal). This step must succeed for the loop to stop, so
   *     its failure is the loudest log here.
   *  3. TELL the user on-thread (persisted): losing a message silently is the one outcome
   *     worse than the hang. Wording depends on whether the hung turn already delivered
   *     something (translator updates / early bubbles) this turn.
   */
  private async abandonHungTurn(
    threadId: string,
    run: TurnRunHandle,
    startedAt: number,
    timeoutMs: number,
  ): Promise<void> {
    const sentThisTurn = (this.gateway.lastSentAt?.(threadId) ?? 0) > startedAt;
    log.error('turn watchdog fired — abandoning hung turn-run', {
      threadId,
      runId: run.runId,
      timeoutMs,
      hungForMs: Date.now() - startedAt,
      sentThisTurn,
    });

    try {
      await run.cancel();
    } catch (err) {
      log.warn('watchdog could not cancel the hung run (continuing to retire inbound)', {
        threadId,
        runId: run.runId,
        err: String(err),
      });
    }

    try {
      // Everything currently unanswered — the window the hung run was answering plus anything
      // that arrived during the hang (the apology's "send it again" covers those too).
      const pending = await this.store.unansweredSteers(threadId, []);
      await this.store.markAnsweredForThread(
        threadId,
        pending.map((p) => p.messageId),
      );
    } catch (err) {
      // If this fails the worker loop WILL re-run the turn — the exact double-text hazard the
      // retire exists to prevent. Log at maximum volume; the re-run at least answers the user.
      log.error(
        'watchdog could not retire unanswered inbound — the thread may re-run and double-text',
        { threadId, runId: run.runId, err: String(err) },
      );
      return; // don't also send the "I gave up" note when a re-run is about to answer anyway
    }

    try {
      await this.gateway.stopTyping?.(threadId).catch(() => {});
      await this.gateway.send(
        threadId,
        { text: sentThisTurn ? WATCHDOG_NOTE_PARTIAL : WATCHDOG_NOTE_NOTHING_SENT },
        { persist: true }, // history must show the loss — the next turn sees it, not a gap
      );
    } catch (err) {
      log.error('watchdog could not notify the user of the abandoned turn', {
        threadId,
        runId: run.runId,
        err: String(err),
      });
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
    const runStartedAt = Date.now();
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
          // Typing shows while the turn streams (throttled), then is cleared two ways at turn end
          // (belt-and-suspenders against the stuck-on-after-reply bug): an explicit `stopTyping`
          // in the `finally`, AND we stop RE-ARMING it once this turn has delivered a message.
          // The latter matters because `send_message` fires MID-stream: without it, the model's
          // post-send wrap-up chunks (a second tool call, a final empty step) re-fire typing >4s
          // after the reply already landed, and it lingers until the next explicit stop / auto-
          // expiry. `lastSentAt` is per-thread, so compare to this run's start = "sent THIS turn".
          if ((this.gateway.lastSentAt?.(threadId) ?? 0) > runStartedAt) continue;
          const now = Date.now();
          if (now - (this.lastTyped.get(threadId) ?? 0) >= TYPING_THROTTLE_MS) {
            this.lastTyped.set(threadId, now);
            await this.gateway.startTyping(threadId).catch(() => {});
          }
        }
      } catch (err) {
        log.debug('run stream bridge ended', { runId, threadId, err: String(err) });
      } finally {
        await reader?.cancel().catch(() => {});
        // Clear the typing indicator now that the turn is done (explicit stop; falls back to the
        // transport's auto-expiry if the driver has no `stopTyping`).
        await this.gateway.stopTyping?.(threadId).catch(() => {});
        let status: 'finished' | 'errored' = 'finished';
        try {
          // The chunk stream closes when the AGENT LOOP ends, but the run keeps working —
          // backstop, sends, the persisted turn row. Settling at stream close made the
          // dashboard's settle-refetch reliably miss the new turn row (the "user message
          // out of order" bug, 2026-07-05). `.status` is a point-in-time read, so AWAIT the
          // run's completion first — `done` must mean "persisted and queryable". Bounded a
          // hair past the watchdog so an abandoned run can never wedge this bridge.
          await Promise.race([
            getRun<unknown>(runId).returnValue.catch(() => {}),
            new Promise((resolve) => setTimeout(resolve, this.meta.turnWatchdogMs + 15_000).unref()),
          ]);
          status = (await getRun<unknown>(runId).status) === 'failed' ? 'errored' : 'finished';
        } catch {
          /* keep optimistic 'finished' */
        }
        bus.finishTurn(runId, status);
      }
    })();
  }
}
