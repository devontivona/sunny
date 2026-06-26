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

  useEffect(() => {
    setMessage(null);
    setRun(null);
    setDone(false);
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

  return { message, run, done };
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
