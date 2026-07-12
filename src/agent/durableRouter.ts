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

/** The user-facing note when a turn fails REPEATEDLY (not hung — it throws/errors each attempt).
 *  After the retry cap the worker retires the inbound with this note instead of looping forever
 *  (R7). */
const RETRY_EXHAUSTED_NOTE =
  'Sorry — I kept hitting an error trying to answer that and had to stop. Mind trying again in a bit?';

/** How the serial worker bounds a turn that keeps FAILING (throwing / failing to start), so a
 *  deterministically-broken turn can't spin the loop forever — each fresh run re-answers from
 *  scratch, re-sending already-delivered bubbles and burning model spend (R7). After
 *  `maxConsecutiveFailures` back-to-back failures the inbound is retired with an apology. */
export interface TurnRetryPolicy {
  maxConsecutiveFailures: number;
  /** Backoff before the Nth (1-indexed) consecutive-failure retry. */
  backoffMs: (failureCount: number) => number;
}

const DEFAULT_RETRY: TurnRetryPolicy = {
  maxConsecutiveFailures: 5,
  backoffMs: (n) => Math.min(500 * 2 ** (n - 1), 30_000),
};

/**
 * Inbound coalescing (multipart-coalesce, 2026-07-07). One iMessage composer action
 * (text + link + image) arrives from Sendblue as SEPARATE webhooks, 0.5–5s apart
 * (confirmed in the Jul 06 firecrawl-link incident: one send → four RECEIVED webhooks over
 * 12s). Without a quiet period the first part starts a turn and the model answers a
 * fragment. So the worker waits for the thread to go QUIET before starting a turn: each
 * new arrival extends the wait. The window is longer when the newest part carries media or
 * a bare URL — the signature of a multipart send whose siblings are still in flight —
 * and short for plain text so ordinary messages pay minimal latency.
 */
export interface CoalescePolicy {
  /** Quiet period after a plain-text inbound. */
  quietMs: number;
  /** Quiet period when the newest inbound has attachments or is link-ish (multipart likely). */
  quietMediaMs: number;
}

const DEFAULT_COALESCE: CoalescePolicy = { quietMs: 2_000, quietMediaMs: 3_000 };

/** A message that smells like part of a multipart send: it carries media, is media-only
 *  (empty text), or is a bare URL (a link bubble whose preview/attachment webhooks trail it). */
function multipartish(event: ChannelEvent): boolean {
  const text = event.text.trim();
  return event.attachments.length > 0 || text === '' || /^https?:\/\/\S+$/.test(text);
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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
  /** Epoch ms of each live run's most recent stream chunk (the watchdog's activity
   *  signal, watchdog-activity D1) — touched by the bridge, read by the race. */
  private readonly runActivity = new Map<string, number>();
  /** Cancel handles for live stream bridges, so the abandon path can tear a bridge
   *  down instead of leaving it blocked on a cancelled run's never-closing stream
   *  (the dashboard phantom-running bug, watchdog-activity D3). */
  private readonly bridgeCancels = new Map<string, () => void>();
  /** The newest live inbound per thread (multipart-coalesce): when it landed and how long
   *  the thread must be quiet before a turn starts. In-memory only — recovery/wake paths
   *  have no entry and start immediately. */
  private readonly lastInbound = new Map<string, { at: number; quietMs: number }>();

  constructor(
    private readonly gateway: Gateway,
    private readonly store: ConversationStore,
    private readonly meta: {
      modelId: string;
      effort: string | null;
      /** HARD CAP: abandon a turn past this total runtime even if still active. */
      turnWatchdogMs: number;
      /** Abandon a turn with NO run-stream activity for this long (a true hang). */
      turnInactivityMs: number;
    },
    /** Test seam: how a turn-run is started (production = the real WDK run). */
    private readonly runs: TurnRunner = startConversationRun,
    /** How the worker bounds a repeatedly-failing turn (R7). Injectable so tests can use a tiny
     *  backoff; production uses {@link DEFAULT_RETRY}. */
    private readonly retry: TurnRetryPolicy = DEFAULT_RETRY,
    /** Quiet-period lengths (multipart-coalesce). Injectable so tests use tiny windows. */
    private readonly coalesce: CoalescePolicy = DEFAULT_COALESCE,
  ) {}

  /** Record observable activity for a live run (the watchdog's signal, watchdog-activity
   *  D1). Called by the stream bridge on every chunk; public as a seam for tests and any
   *  future non-stream activity source. */
  touchRunActivity(runId: string): void {
    this.runActivity.set(runId, Date.now());
  }

  /** Route one inbound (already persisted + deduped by the gateway): ensure this thread's
   *  serial worker is draining its unanswered inbound as durable turn-runs. Also tells the
   *  live bus a message landed, so an open Conversation page shows a MID-TURN reply (one
   *  that will fold into the running turn, invisible to the model-chunk stream) immediately
   *  instead of after the turn settles. */
  route(event: ChannelEvent): void {
    getLiveBus().publishThreadInbound(event.threadId);
    // Multipart-coalesce: remember when this inbound landed and how long the thread should
    // stay quiet before a turn starts. Each arrival OVERWRITES the entry, so a trickle of
    // split webhooks keeps extending the wait until the whole send has landed.
    this.lastInbound.set(event.threadId, {
      at: Date.now(),
      quietMs: multipartish(event) ? this.coalesce.quietMediaMs : this.coalesce.quietMs,
    });
    this.ensureWorker(event.threadId);
  }

  /**
   * Wake a thread's run-supply (durable-subagents D-DS13): ensure a serial worker is draining it.
   * The runtime exposes this as `wakeThread` so a `'use step'` can nudge the router after writing
   * to a thread's inbox out-of-band — e.g. a child reporting to its parent (the parent thread is a
   * normal conversation thread this router already drives), or the watchdog delivering a failure.
   */
  wake(threadId: string): void {
    // Every wake caller has just appended to the thread's inbox out-of-band (a child's
    // report, a watchdog note) — surface it to an open Conversation page like `route`.
    getLiveBus().publishThreadInbound(threadId);
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
    // Track EVERY same-thread orphan, not last-wins (AdoptRun): a thread can have several runs
    // still RUNNING at startup (e.g. a mid-turn steer spawned a second run), and a plain `.set`
    // would silently drop an earlier handle so that run is never driven/watchdogged/cancelled.
    const list = this.adopted.get(threadId);
    if (list) list.push(run);
    else this.adopted.set(threadId, [run]);
    this.ensureWorker(threadId);
  }

  private readonly adopted = new Map<string, TurnRunHandle[]>();

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
        // Adopted restart-orphans run FIRST, through the full turn machinery; only after they
        // settle (and marked their messages) does the drain below see what's left. There can be
        // more than one per thread (AdoptRun) — drive each.
        const orphans = this.adopted.get(threadId);
        if (orphans && orphans.length > 0) {
          this.adopted.delete(threadId);
          for (const orphan of orphans) {
            await this.driveTurn(threadId, orphan);
          }
        }
        // Bound consecutive turn FAILURES (R7): a turn that throws AFTER sending some bubbles but
        // BEFORE marking answered leaves the inbound unanswered, so this loop would otherwise spin
        // forever — each fresh run re-sends the already-delivered bubbles + burns model spend.
        let consecutiveFailures = 0;
        while (await this.store.hasUnansweredInbound(threadId)) {
          // Multipart-coalesce: wait for the thread to go quiet before starting the turn, so
          // the split webhooks of one composer send land in ONE prompt window. Re-reads the
          // entry each pass — a part arriving during the wait extends it.
          await this.awaitQuiet(threadId);
          const ok = await this.runTurn(threadId);
          if (ok) {
            consecutiveFailures = 0;
            continue;
          }
          consecutiveFailures += 1;
          if (consecutiveFailures >= this.retry.maxConsecutiveFailures) {
            await this.retireFailedInbound(threadId);
            break;
          }
          await delay(this.retry.backoffMs(consecutiveFailures));
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

  /** Wait until the thread's newest inbound is at least its quiet period old
   *  (multipart-coalesce). No entry (recovery / out-of-band wake) → no wait. */
  private async awaitQuiet(threadId: string): Promise<void> {
    for (;;) {
      const entry = this.lastInbound.get(threadId);
      if (!entry) return;
      const remaining = entry.at + entry.quietMs - Date.now();
      if (remaining <= 0) return;
      await delay(remaining);
    }
  }

  /** Run ONE durable turn for a thread and await its completion — bounded by the watchdog
   *  (hung-model-stream exposure): a stalled model stream must never block the thread forever.
   *  Returns `false` when the turn failed in a way that left the inbound unanswered (start
   *  failure, a non-watchdog rejection, or a hung turn the watchdog could not retire) — the
   *  worker uses this to bound consecutive failures (R7). */
  private async runTurn(threadId: string): Promise<boolean> {
    let run: TurnRunHandle | undefined;
    try {
      run = await this.runs(threadId);
    } catch (err) {
      log.error('conversation turn-run failed to start', { threadId, err: String(err) });
      return false;
    }
    return this.driveTurn(threadId, run);
  }

  /** Drive one (fresh or adopted) turn-run: stream bridge (live pane + typing), watchdog
   *  race, explicit abandon on timeout. Shared by `runTurn` and `adoptRun`. Returns `false`
   *  when the turn left the inbound unanswered (see {@link runTurn}). */
  private async driveTurn(threadId: string, run: TurnRunHandle): Promise<boolean> {
    const startedAt = Date.now();
    try {
      this.bridgeRunStream(run.runId, threadId);
      // Durable: resolves when the turn (incl. its delivery step) is done. Raced against the
      // activity-aware watchdog (watchdog-activity D2): a healthy tool-heavy turn keeps
      // running as long as its stream keeps moving; a stalled stream is caught at the
      // inactivity budget; the hard cap bounds runaway-but-active turns.
      await raceTurnWatchdog(run.returnValue, {
        inactivityMs: this.meta.turnInactivityMs,
        maxMs: this.meta.turnWatchdogMs,
        lastActivityAt: () => this.runActivity.get(run.runId) ?? 0,
      });
      return true;
    } catch (err) {
      if (err instanceof TurnWatchdogTimeout) {
        return this.abandonHungTurn(threadId, run, startedAt, err);
      }
      log.error('conversation turn-run failed', {
        threadId,
        runId: run.runId,
        err: String(err),
      });
      return false;
    }
  }

  /**
   * The watchdog fired: the turn-run has been hung past the budget (typically a stalled model
   * stream). Recovery design — an EXPLICIT, observable failure, never a silent re-run:
   *
   *  1. CANCEL the run in the WDK world (best-effort), so a zombie that un-hangs later can't
   *     keep executing steps (late bubbles, a stale `markAnswered` racing a fresh turn).
   *  2. TELL the user on-thread (persisted): losing a message silently is the one outcome
   *     worse than the hang. Wording depends on whether the hung turn already delivered
   *     something (translator updates / early bubbles) this turn. This happens BEFORE the
   *     retire (Watchdog fix): if the send fails — e.g. the same outage that hung the turn —
   *     we must NOT retire, or the messages would be permanently consumed with no reply. On a
   *     send failure we return `false` (not retired), leaving the inbound for the worker to
   *     retry (bounded by the R7 failure cap) rather than silently swallowing it.
   *  3. RETIRE the thread's unanswered inbound. This is the double-text guard (the PR #29
   *     duplicate-reply class): the worker's `hasUnansweredInbound` loop would otherwise start
   *     a FRESH run for the same messages — and a fresh run is not a replay, it re-answers from
   *     scratch, re-sending anything the hung run already delivered (its sends are memoized only
   *     within the SAME run's journal).
   *
   * Returns `true` once the inbound is retired (loop can stop), `false` if it must stay
   * unanswered (send failed) so the worker re-runs it under the R7 cap.
   */
  private async abandonHungTurn(
    threadId: string,
    run: TurnRunHandle,
    startedAt: number,
    timeout: TurnWatchdogTimeout,
  ): Promise<boolean> {
    const sentThisTurn = (this.gateway.lastSentAt?.(threadId) ?? 0) > startedAt;
    log.error('turn watchdog fired — abandoning turn-run', {
      threadId,
      runId: run.runId,
      reason: timeout.reason, // 'inactivity' = true hang; 'cap' = runaway-but-active
      timeoutMs: timeout.timeoutMs,
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

    // Settle the observable state NOW (watchdog-activity D3 — the dashboard phantom-
    // running bug): tear down the stream bridge (a cancelled run's stream may never
    // close, leaving the bridge blocked on read() and its own settle unreached), and
    // eagerly mark the LiveBus entry terminal. finishTurn is idempotent, so the
    // bridge's own settle landing later is a no-op.
    this.bridgeCancels.get(run.runId)?.();
    getLiveBus().finishTurn(run.runId, 'errored');

    try {
      await this.gateway.stopTyping?.(threadId).catch(() => {});
      await this.gateway.send(
        threadId,
        { text: sentThisTurn ? WATCHDOG_NOTE_PARTIAL : WATCHDOG_NOTE_NOTHING_SENT },
        { persist: true }, // history must show the loss — the next turn sees it, not a gap
      );
    } catch (err) {
      // The note didn't land (likely the same outage that hung the turn). Do NOT retire — leaving
      // the inbound unanswered lets the worker re-run it (bounded by the R7 cap), which is far
      // better than silently consuming the messages with no reply.
      log.error('watchdog could not notify the user — leaving the inbound for a bounded retry', {
        threadId,
        runId: run.runId,
        err: String(err),
      });
      return false;
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
      // The user WAS notified, but we couldn't retire — the worker loop may re-run and double-text.
      // Log at maximum volume and count it as a failure so the R7 cap bounds the re-run.
      log.error(
        'watchdog could not retire unanswered inbound — the thread may re-run and double-text',
        { threadId, runId: run.runId, err: String(err) },
      );
      return false;
    }

    return true;
  }

  /**
   * The turn kept FAILING past the retry cap (R7): stop the serial worker's re-run loop. A turn
   * that throws each attempt (not a hang — the watchdog handles those) would otherwise spin the
   * `hasUnansweredInbound` loop forever, re-sending already-delivered bubbles and burning model
   * spend. Best-effort tell the user, then retire (mark answered) so the loop terminates. Both
   * steps are independently guarded; the worker `break`s regardless, so a failure here can't
   * re-loop.
   */
  private async retireFailedInbound(threadId: string): Promise<void> {
    log.error('conversation turn failed repeatedly — retiring inbound to stop the re-run loop', {
      threadId,
      failures: this.retry.maxConsecutiveFailures,
    });
    try {
      await this.gateway.stopTyping?.(threadId).catch(() => {});
      await this.gateway.send(threadId, { text: RETRY_EXHAUSTED_NOTE }, { persist: true });
    } catch (err) {
      log.error('could not notify the user of the repeatedly-failing turn', {
        threadId,
        err: String(err),
      });
    }
    try {
      const pending = await this.store.unansweredSteers(threadId, []);
      await this.store.markAnsweredForThread(
        threadId,
        pending.map((p) => p.messageId),
      );
    } catch (err) {
      log.error('could not retire inbound after repeated turn failures', {
        threadId,
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
    this.runActivity.set(runId, runStartedAt);
    void (async () => {
      let reader: ReadableStreamDefaultReader<UIMessageChunk> | null = null;
      // The abandon path tears this bridge down via the cancel handle: reader.cancel()
      // makes the blocked read() settle, so the finally below (typing stop + LiveBus
      // settle) actually runs for a cancelled run whose stream never closes (D3).
      this.bridgeCancels.set(runId, () => void reader?.cancel().catch(() => {}));
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
          // Every chunk — model deltas, tool calls, tool results at step boundaries —
          // is the watchdog's activity signal (watchdog-activity D1).
          this.touchRunActivity(runId);
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
            new Promise((resolve) =>
              setTimeout(resolve, this.meta.turnWatchdogMs + 15_000).unref(),
            ),
          ]);
          status = (await getRun<unknown>(runId).status) === 'failed' ? 'errored' : 'finished';
        } catch {
          /* keep optimistic 'finished' */
        }
        bus.finishTurn(runId, status); // no-op if the abandon path settled first (idempotent)
        this.bridgeCancels.delete(runId);
        this.runActivity.delete(runId);
      }
    })();
  }
}
