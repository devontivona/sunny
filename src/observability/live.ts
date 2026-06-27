/**
 * Live in-flight run event source (live-conversation-streaming D; observability
 * "Live in-flight run event source"). A read-only, in-process publish seam that
 * forwards a turn's `UIMessageChunk`s to dashboard subscribers as the turn runs —
 * so the Conversation page can render Sunny's activity live, newest-first, without
 * a manual refresh.
 *
 * Scope split by tier (see the change's design.md):
 * - Tier-1 conversational TURNS run in-process and are NOT workflow runs, so they
 *   can't use WDK durable streams. This bus bridges that gap: the loop taps the
 *   `UIMessage` stream it already produces (loop.ts) and forwards the same chunks
 *   here. A bounded per-run replay buffer lets a late-joining client catch up;
 *   turns are ephemeral (the persisted turn is the source of truth on completion).
 * - Tier-2 JOBS already write `UIMessageChunk`s to their durable WDK run stream
 *   (`getWritable` in workflows/job.ts), so they are streamed straight from the
 *   workflow world by run id — they do NOT go through this bus. Active jobs are
 *   derived from the WDK world (see DashboardData.activeJobs).
 *
 * The bus is pinned on `globalThis` (like the runtime singleton) so it survives the
 * unified dev server's back-end module re-evaluation, and is inert when nothing is
 * subscribed. Every chunk is run through the shared redactor before it is buffered
 * or emitted, so no secret value can leak onto the live wire (observability D-OB5).
 */

import type { UIMessageChunk } from 'ai';
import { defaultRedactor, type Redactor } from './redact.js';

/** Token usage for a run, mirroring the persisted turn metadata shape. */
export interface RunUsage {
  in: number | null;
  out: number | null;
  cached: number | null;
  cacheWrite: number | null;
}

export type RunKind = 'turn' | 'job';
export type RunStatus = 'running' | 'finished' | 'errored';

/**
 * The unified run descriptor shared by turns and jobs and sent to the dashboard
 * (as JSON) for the home "active now" indicator and the live status bar. Timestamps
 * are ISO strings so the client can render elapsed time.
 */
export interface LiveRun {
  runId: string;
  kind: RunKind;
  threadId: string | null;
  label: string;
  status: RunStatus;
  startedAt: string;
  steps: number;
  model: string | null;
  effort: string | null;
  usage: RunUsage | null;
  /** Link to the run's trajectory trace (Langfuse), if known. */
  traceUrl: string | null;
}

/** An event delivered to a turn subscriber. */
export type LiveEvent =
  | { type: 'status'; run: LiveRun }
  | { type: 'chunk'; chunk: UIMessageChunk }
  | { type: 'done'; run: LiveRun };

type Subscriber = (event: LiveEvent) => void;

interface TurnEntry {
  run: LiveRun;
  /** Bounded ring of redacted chunks for late-join replay. */
  buffer: UIMessageChunk[];
  subscribers: Set<Subscriber>;
  /** epoch ms of the last publish/update — drives stale-run reaping. */
  updatedAt: number;
  /** epoch ms when the run reached a terminal state, or 0 while running. */
  finishedAt: number;
}

/** Keep at most this many chunks per turn for replay (a long turn drops its oldest
 *  chunks; the persisted record settles the view on completion). */
const MAX_BUFFER = 4000;
/** Drop a finished run from the active set this long after it completes. */
const FINISHED_TTL_MS = 60_000;
const REAP_INTERVAL_MS = 30_000;

export class LiveBus {
  private readonly turns = new Map<string, TurnEntry>();
  /** Subscribers following a whole thread (the Conversation page): they receive
   *  events for whatever turn is running on that thread, across turns — so an
   *  already-open page streams the next turn instantly, with no polling gap. */
  private readonly threadSubs = new Map<string, Set<Subscriber>>();

  constructor(private readonly redactor: Redactor = defaultRedactor()) {
    // Periodic reap of finished/stale runs. Unref'd so it never holds the process
    // open; a no-op when the map is empty.
    setInterval(() => this.reap(), REAP_INTERVAL_MS).unref();
  }

  /** Register a turn at its start. Idempotent on `runId` — a duplicate register is a
   *  no-op so an existing entry's buffer/subscribers are never discarded. */
  registerTurn(init: {
    runId: string;
    threadId: string | null;
    label: string;
    model: string | null;
    effort: string | null;
    traceUrl?: string | null;
  }): void {
    if (this.turns.has(init.runId)) return;
    const now = Date.now();
    this.turns.set(init.runId, {
      run: {
        runId: init.runId,
        kind: 'turn',
        threadId: init.threadId,
        label: init.label,
        status: 'running',
        startedAt: new Date(now).toISOString(),
        steps: 0,
        model: init.model,
        effort: init.effort,
        usage: null,
        traceUrl: init.traceUrl ?? null,
      },
      buffer: [],
      subscribers: new Set(),
      updatedAt: now,
      finishedAt: 0,
    });
    // Tell any open thread subscribers that a new turn started (so a page already
    // open on this thread begins streaming immediately).
    const entry = this.turns.get(init.runId);
    if (entry) this.emit(entry, { type: 'status', run: entry.run });
  }

  /** Forward one `UIMessageChunk` for a turn: redact, buffer (bounded), advance the
   *  step counter, and emit to subscribers. No-op if the run is unknown. */
  publishTurnChunk(runId: string, chunk: UIMessageChunk): void {
    const entry = this.turns.get(runId);
    if (!entry) return;
    const safe = this.redactor.redact(chunk);
    entry.buffer.push(safe);
    if (entry.buffer.length > MAX_BUFFER) entry.buffer.shift();
    entry.updatedAt = Date.now();
    // A new model step begins at each `start-step` chunk.
    if (safe.type === 'start-step') {
      entry.run.steps += 1;
      this.emit(entry, { type: 'status', run: entry.run });
    }
    this.emit(entry, { type: 'chunk', chunk: safe });
  }

  /** Mark a turn terminal and publish the final status. Subscribers get a `done`
   *  event; the entry is kept briefly (FINISHED_TTL) so a just-finished run still
   *  appears active while the client settles to the persisted record. */
  finishTurn(
    runId: string,
    status: Exclude<RunStatus, 'running'>,
    patch?: { steps?: number; usage?: RunUsage | null },
  ): void {
    const entry = this.turns.get(runId);
    if (!entry) return;
    entry.run.status = status;
    if (patch?.steps != null) entry.run.steps = patch.steps;
    if (patch?.usage !== undefined) entry.run.usage = patch.usage;
    entry.updatedAt = Date.now();
    entry.finishedAt = entry.updatedAt;
    this.emit(entry, { type: 'status', run: entry.run });
    this.emit(entry, { type: 'done', run: entry.run });
  }

  /**
   * Subscribe to a turn's live events. Immediately replays the current status and
   * buffered chunks (late-join catch-up), then streams subsequent events. Returns an
   * unsubscribe function. If the run is unknown, the subscriber gets nothing and the
   * unsubscribe is a no-op (the client will fall back to the persisted record).
   */
  subscribeTurn(runId: string, fn: Subscriber): () => void {
    const entry = this.turns.get(runId);
    if (!entry) return () => {};
    fn({ type: 'status', run: entry.run });
    for (const chunk of entry.buffer) fn({ type: 'chunk', chunk });
    if (entry.run.status !== 'running') fn({ type: 'done', run: entry.run });
    entry.subscribers.add(fn);
    return () => {
      entry.subscribers.delete(fn);
    };
  }

  /**
   * Subscribe to a whole thread's live events (the Conversation page). Replays the
   * thread's currently-running turn (if any) for immediate catch-up, then streams
   * events for that turn and every later turn on the thread — so an already-open
   * page begins streaming the next message with no polling gap. Returns unsubscribe.
   */
  subscribeThread(threadId: string, fn: Subscriber): () => void {
    let set = this.threadSubs.get(threadId);
    if (!set) {
      set = new Set();
      this.threadSubs.set(threadId, set);
    }
    set.add(fn);
    // Replay only a currently-running turn (a finished one is already the persisted
    // bubble; replaying it would just flicker the live view).
    const running = [...this.turns.values()]
      .filter((e) => e.run.threadId === threadId && e.run.status === 'running')
      .sort((a, b) => b.updatedAt - a.updatedAt)[0];
    if (running) {
      fn({ type: 'status', run: running.run });
      for (const chunk of running.buffer) fn({ type: 'chunk', chunk });
    }
    return () => {
      const s = this.threadSubs.get(threadId);
      if (!s) return;
      s.delete(fn);
      if (s.size === 0) this.threadSubs.delete(threadId);
    };
  }

  /** Snapshot of currently-active (running or just-finished) turns. */
  activeTurns(): LiveRun[] {
    return [...this.turns.values()].map((e) => e.run);
  }

  /** Current descriptor for one turn, if tracked. */
  getTurn(runId: string): LiveRun | null {
    return this.turns.get(runId)?.run ?? null;
  }

  private emit(entry: TurnEntry, event: LiveEvent): void {
    for (const fn of entry.subscribers) {
      try {
        fn(event);
      } catch {
        // A failing subscriber must not break the publish path or sibling readers.
      }
    }
    // Also deliver to anyone following the whole thread this run belongs to.
    const threadSet = entry.run.threadId ? this.threadSubs.get(entry.run.threadId) : undefined;
    if (threadSet) {
      for (const fn of threadSet) {
        try {
          fn(event);
        } catch {
          // isolate subscriber failures
        }
      }
    }
  }

  private reap(): void {
    const now = Date.now();
    for (const [runId, entry] of this.turns) {
      // Only reap FINISHED runs (after a short settle window). A running entry is
      // always finished explicitly by the loop (success or error path), so within a
      // process it never needs TTL reaping — and TTL-reaping a running turn would
      // wrongly kill a long, quiet tool call (no chunks emitted for minutes, e.g. a
      // long build) that is still executing. (On a process crash the in-memory bus is
      // gone anyway, so there is nothing to reap.)
      if (entry.finishedAt && now - entry.finishedAt > FINISHED_TTL_MS) {
        this.turns.delete(runId);
      }
    }
  }
}

const BUS_KEY = Symbol.for('sunny.liveBus');

/** The process-wide live bus, pinned on `globalThis` so it survives the unified dev
 *  server's back-end module re-evaluation (mirrors the runtime singleton). */
export function getLiveBus(): LiveBus {
  const g = globalThis as Record<symbol, unknown>;
  if (!g[BUS_KEY]) g[BUS_KEY] = new LiveBus();
  return g[BUS_KEY] as LiveBus;
}
