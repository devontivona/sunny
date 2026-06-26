## 1. Live event bus & run model (back end core)

- [ ] 1.1 Define the `Run` model and live event types (discriminated union: `run-started`, `step-start`, `text-delta`, `tool-call`, `tool-result`/`tool-error`, `usage`, `status`, `run-finished`), each carrying `runId` and a monotonic per-run `seq`, in a new module under `src/dashboard/` (or `src/observability/`).
- [ ] 1.2 Implement `LiveBus` (thin wrapper over Node `EventEmitter`) behind a small publish/subscribe interface, plus an in-memory **active-runs registry** (add on start, update on event, reap on finish or TTL/heartbeat staleness). Bus is a no-op when there are no subscribers.
- [ ] 1.3 Construct the `LiveBus` once in `src/runtime.ts` and hold it on the runtime singleton (alongside gateway/scheduler/store) so it survives back-end HMR and is reachable by publishers and the SSE route.
- [ ] 1.4 Route every published event payload through the existing telemetry **redaction** layer before it leaves the publisher (no secret values, no token-bearing URLs / `op://` resolution).

## 2. Publish in-flight activity from turns and jobs

- [ ] 2.1 In `src/agent/loop.ts`, mint a turn `runId` at turn start, register the run (kind `turn`, `threadId`, model, effort, `traceUrl`), and publish `run-started`/`status`.
- [ ] 2.2 Tap the existing `UIMessageStream` consumption in `loop.ts` to publish step/tool/text/usage events as parts arrive (in addition to the current accumulate-then-`appendTurn`); coalesce text deltas on a short timer into a rolling in-progress text.
- [ ] 2.3 Publish `run-finished` and deregister the run after `store.appendTurn(...)` / `logTurnSummary()` completes (so the persisted record exists before the client is told to settle).
- [ ] 2.4 In `workflows/job.ts` and `workflows/scheduledJob.ts`, publish equivalent run/step/tool/status events keyed by the WDK run id, as **best-effort, non-durable side effects** (outside durable-step semantics) so durable replay does not corrupt persistence; rely on per-run `seq` for client-side dedupe.

## 3. SSE + active-runs API (back end routes)

- [ ] 3.1 Add a streaming dashboard route `server/routes/dashboard/api/live/...` returning `text/event-stream`, behind the **same session auth gate** as the rest of `/dashboard/api/**`; reject unauthenticated requests identically to other dashboard calls.
- [ ] 3.2 On connect, emit a snapshot of active runs + a bounded per-run replay buffer, then tail the `LiveBus`; close cleanly on client disconnect.
- [ ] 3.3 Add a lightweight `/dashboard/api/live/active` JSON endpoint returning the current active-runs summary (for the home indicator's initial paint).
- [ ] 3.4 Verify the live routes carry no control affordance and expose no secret values (manual + redaction unit check).

## 4. Front-end live data layer

- [ ] 4.1 Add a `useActiveRuns()` hook and a `useLiveRun(runId)` hook wrapping `EventSource` (connect, auto-reconnect, snapshot-then-tail, `seq` dedupe/replace), parallel to the existing `useAsync` hook in `app/components/ui.tsx`.
- [ ] 4.2 Extend `app/types.ts` with the `Run`, live-event, and per-step types; extend `app/api.ts` with the active-runs fetch + the SSE URL.
- [ ] 4.3 Implement settle-to-persisted: on `run-finished`, refetch the persisted thread via the existing `/conversation/thread` endpoint and replace the provisional in-flight turn.

## 5. Conversation view rework

- [ ] 5.1 Render the thread **reverse-chronological (newest first)**, top-down, in `app/pages/Conversation.tsx`.
- [ ] 5.2 Build a shared `<RunView>` component: per-step rendering (thinking/scratch, tool call name+args, tool result/error, step boundaries) plus a live status bar (status, elapsed, step count, live token usage incl. cache read/write, model/effort, Langfuse trace link).
- [ ] 5.3 Pin the in-flight turn at the top of the thread using `useLiveRun`, updating live, then settling to the persisted turn on finish; ensure the view does not error when nothing is active (idle = most-recent persisted activity only).
- [ ] 5.4 Keep the view strictly observe-only — no send/cancel/retry/edit controls anywhere in the new step UI.

## 6. Home-page live indicator

- [ ] 6.1 In `app/pages/Home.tsx`, add an "active now" banner driven by `useActiveRuns()` that is absent (or shows an explicit idle state) when nothing is running and never deep-links to a non-existent run.
- [ ] 6.2 Deep-link each active run to its live view (Conversation thread for turns, job run view for jobs); support multiple concurrent active runs.

## 7. Background-job live view reuse

- [ ] 7.1 Reuse `<RunView>` to render an actively-running Tier-2 job (steps, tool calls/results, status, elapsed, live token usage) from `useLiveRun(jobRunId)`.
- [ ] 7.2 Link running jobs from `app/pages/Jobs.tsx` and from the home indicator into the shared live run view; keep it observe-only (no trigger/pause/cancel/retry).

## 8. Verification

- [ ] 8.1 Unit-test the `LiveBus`/registry (subscribe/publish ordering, `seq`, TTL reaping, no-op when idle) and the redaction of event payloads.
- [ ] 8.2 Integration test: drive a turn end-to-end and assert the SSE stream emits ordered step/tool/usage/finish events and that the streamed turn matches the persisted record after `run-finished`.
- [ ] 8.3 Manual check on the devbox: open the Conversation page while Sunny processes a turn — newest-first, live steps appear without refresh, in-flight turn settles to persisted on completion; home indicator appears and deep-links; a running job renders in the same view. Restart the devbox service after merge (HMR may serve stale code).
- [ ] 8.4 Run `openspec validate live-conversation-streaming` and the repo checks (incl. the `DESIGN.md` linter if any theme tokens were touched).
