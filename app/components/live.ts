import { useEffect, useState } from 'react';
import { readUIMessageStream, type UIMessage, type UIMessageChunk } from 'ai';
import { apiGet } from '../api';
import type { ActiveRunsView, LiveRun, RunKind } from '../types';

// Live observability data layer (live-conversation-streaming). These hooks sit
// alongside `useAsync`: `useActiveRuns` polls the active-runs snapshot for the home
// indicator and the Conversation page's "is this thread live?" check, and
// `useLiveRun` opens an SSE stream for one run and folds its UIMessageChunks into a
// live `UIMessage` with the AI SDK's `readUIMessageStream` — the same assembly the
// server uses — so the live view renders the exact parts that get persisted.

/** Poll the active-runs snapshot. Lightweight and robust for a single user; the
 *  list is small and changes are surfaced within `intervalMs`. */
export function useActiveRuns(intervalMs = 4000): LiveRun[] {
  const [runs, setRuns] = useState<LiveRun[]>([]);
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const data = await apiGet<ActiveRunsView>('/live/active');
        if (live) setRuns(data.runs);
      } catch {
        // Transient (e.g. a brief 401 during re-pair) — keep the last snapshot.
      }
      if (live) timer = setTimeout(tick, intervalMs);
    };
    void tick();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [intervalMs]);
  return runs;
}

export interface LiveRunState {
  /** The in-flight assistant message, folded from the chunk stream (null until the
   *  first chunk arrives, or if the run is already over). */
  message: UIMessage | null;
  /** Latest run descriptor (status, steps, usage, model/effort). */
  run: LiveRun | null;
  /** True once the run has reached a terminal state on the wire. */
  done: boolean;
  /** True once the SSE connection has hard-failed (a 401 / closed stream that
   *  won't auto-reconnect) — lets the view stop showing "responding…" and mark the
   *  data as stale instead of hanging forever. */
  error: boolean;
  /** Increments on every streamed chunk — a stable "content grew" signal for
   *  keeping the view scrolled to the bottom while streaming. */
  version: number;
}

/**
 * Subscribe to one run's live SSE stream. Bridges `EventSource` → a
 * `ReadableStream<UIMessageChunk>` → `readUIMessageStream`, so each chunk advances
 * the rendered `UIMessage`. EventSource auto-reconnects on transient drops; on the
 * terminal `done` event the caller should refetch the persisted record to settle.
 */
export function useLiveRun(runId: string | null, kind: RunKind): LiveRunState {
  const [message, setMessage] = useState<UIMessage | null>(null);
  const [run, setRun] = useState<LiveRun | null>(null);
  const [done, setDone] = useState(false);
  const [error, setError] = useState(false);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    setMessage(null);
    setRun(null);
    setDone(false);
    setError(false);
    if (!runId) return;

    let cancelled = false;
    let controller: ReadableStreamDefaultController<UIMessageChunk> | null = null;
    const stream = new ReadableStream<UIMessageChunk>({
      start(c) {
        controller = c;
      },
    });

    const url = `/dashboard/api/live/stream?run=${encodeURIComponent(runId)}&kind=${kind}`;
    const es = new EventSource(url, { withCredentials: true });

    es.addEventListener('chunk', (e) => {
      try {
        controller?.enqueue(JSON.parse((e as MessageEvent).data) as UIMessageChunk);
        if (!cancelled) setVersion((v) => v + 1);
      } catch {
        /* ignore a malformed frame */
      }
    });
    es.addEventListener('status', (e) => {
      try {
        if (!cancelled) setRun(JSON.parse((e as MessageEvent).data) as LiveRun);
      } catch {
        /* ignore */
      }
    });
    es.addEventListener('done', (e) => {
      try {
        if (!cancelled) setRun(JSON.parse((e as MessageEvent).data) as LiveRun);
      } catch {
        /* ignore */
      }
      if (!cancelled) setDone(true);
      try {
        controller?.close();
      } catch {
        /* already closed */
      }
      es.close();
    });
    // EventSource retries transient drops itself (readyState CONNECTING). A CLOSED
    // state is a hard failure that won't reconnect — most often a 401 after the
    // session lapsed. Surface it (so the pane stops on "responding…" forever) and,
    // like `apiGet`, ask the shell to re-pair. Closing ES stops any reconnect loop.
    es.addEventListener('error', () => {
      if (cancelled || es.readyState !== EventSource.CLOSED) return;
      es.close();
      setError(true);
      window.dispatchEvent(new CustomEvent('dashboard:unauthorized'));
    });

    void (async () => {
      try {
        for await (const m of readUIMessageStream({ stream })) {
          if (cancelled) break;
          setMessage(m);
        }
      } catch {
        /* stream closed/cancelled */
      }
    })();

    return () => {
      cancelled = true;
      es.close();
      try {
        controller?.close();
      } catch {
        /* ignore */
      }
    };
  }, [runId, kind]);

  return { message, run, done, error, version };
}

export interface LiveThreadState {
  /** The in-flight turn's message, folded from the chunk stream (null between turns). */
  message: UIMessage | null;
  /** The current turn's descriptor. */
  run: LiveRun | null;
  /** The runId of the most recently completed turn — bumps on each `done` so the
   *  caller can refetch the persisted thread to settle. */
  lastDoneRunId: string | null;
  /** True once the thread's SSE connection has hard-failed (a 401 / closed stream
   *  that won't auto-reconnect) — lets the view stop showing "responding…" forever. */
  error: boolean;
  /** Increments on every streamed chunk — a stable signal for "content grew", used to
   *  keep the view scrolled to the bottom while streaming. */
  version: number;
  /** Increments when a new INBOUND message lands on the thread (e.g. a mid-turn user
   *  reply that folds into the running turn — it never rides the chunk stream). The
   *  page refetches the persisted thread on this signal so the reply renders live. */
  inboundVersion: number;
}

/**
 * Subscribe to a whole thread's live activity over one SSE connection. Streams
 * whatever turn is running now and every later turn on the thread — so a page that
 * is already open begins streaming the next message instantly (no run-id discovery,
 * no polling gap). The fold resets when a new turn starts (status with a new runId).
 */
export function useLiveThread(threadId: string | null): LiveThreadState {
  const [message, setMessage] = useState<UIMessage | null>(null);
  const [run, setRun] = useState<LiveRun | null>(null);
  const [lastDoneRunId, setLastDoneRunId] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [version, setVersion] = useState(0);
  const [inboundVersion, setInboundVersion] = useState(0);

  useEffect(() => {
    setMessage(null);
    setRun(null);
    setError(false);
    if (!threadId) return;

    let cancelled = false;
    let currentRunId: string | null = null;
    let controller: ReadableStreamDefaultController<UIMessageChunk> | null = null;
    let foldId = 0;

    // (Re)start a fold pipeline for a new turn: a fresh ReadableStream fed by chunk
    // events, consumed by readUIMessageStream into a live UIMessage.
    const startFold = () => {
      const myFold = ++foldId;
      const stream = new ReadableStream<UIMessageChunk>({
        start(c) {
          controller = c;
        },
      });
      void (async () => {
        try {
          for await (const m of readUIMessageStream({ stream })) {
            if (!cancelled && myFold === foldId) setMessage(m);
          }
        } catch {
          /* stream reset/closed */
        }
      })();
    };

    const url = `/dashboard/api/live/stream?thread=${encodeURIComponent(threadId)}`;
    const es = new EventSource(url, { withCredentials: true });

    es.addEventListener('status', (e) => {
      let r: LiveRun;
      try {
        r = JSON.parse((e as MessageEvent).data) as LiveRun;
      } catch {
        return;
      }
      if (cancelled) return;
      if (r.runId !== currentRunId) {
        // New turn: reset the fold so chunks don't concatenate across turns.
        try {
          controller?.close();
        } catch {
          /* ignore */
        }
        currentRunId = r.runId;
        setMessage(null);
        startFold();
      }
      setRun(r);
    });
    es.addEventListener('chunk', (e) => {
      try {
        controller?.enqueue(JSON.parse((e as MessageEvent).data) as UIMessageChunk);
        if (!cancelled) setVersion((v) => v + 1);
      } catch {
        /* ignore a malformed frame */
      }
    });
    es.addEventListener('inbound', () => {
      if (!cancelled) setInboundVersion((v) => v + 1);
    });
    es.addEventListener('done', (e) => {
      try {
        if (!cancelled) setRun(JSON.parse((e as MessageEvent).data) as LiveRun);
      } catch {
        /* ignore */
      }
      if (!cancelled && currentRunId) setLastDoneRunId(currentRunId);
      try {
        controller?.close();
      } catch {
        /* ignore */
      }
      // Keep the EventSource open for the next turn on this thread.
    });
    // EventSource retries transient drops itself (readyState CONNECTING). A CLOSED
    // state is a hard failure that won't reconnect — most often a 401 after the
    // session lapsed. Surface it (so the pane stops on "responding…" forever) and,
    // like `apiGet`, ask the shell to re-pair. Closing ES stops any reconnect loop.
    es.addEventListener('error', () => {
      if (cancelled || es.readyState !== EventSource.CLOSED) return;
      es.close();
      setError(true);
      window.dispatchEvent(new CustomEvent('dashboard:unauthorized'));
    });

    return () => {
      cancelled = true;
      es.close();
      try {
        controller?.close();
      } catch {
        /* ignore */
      }
    };
  }, [threadId]);

  return { message, run, lastDoneRunId, error, version, inboundVersion };
}

/** Re-render every second while `running` so elapsed-time labels tick. The value
 *  stops advancing once `running` is false (the interval clears). */
export function useNow(running: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running]);
  return now;
}
