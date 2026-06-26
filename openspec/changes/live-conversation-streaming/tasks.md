## 1. Shared run model & wire (AI SDK UIMessage)

- [x] 1.1 Define the unified `Run` model (`{ runId, kind: 'turn' | 'job', threadId?, jobName?, label, status, startedAt, model, effort, steps, usage, traceUrl }`) and reuse the AI SDK `UIMessage`/`UIMessageChunk`/`UIMessagePart` types as the canonical live wire and render model (no bespoke event union). Run-level metadata that isn't a message part rides via `UIMessage.metadata` + the registry. — `src/observability/live.ts` (`LiveRun`), `app/types.ts`.
- [x] 1.2 Implement an in-memory **active-runs registry** (add on start, update on event/heartbeat, reap on finish or TTL) on the runtime singleton; expose a snapshot for connect-time + the home indicator. — `LiveBus` (globalThis-pinned, mirrors the runtime singleton); turns from the bus, jobs derived from the WDK world (`DashboardData.activeRuns`).
- [x] 1.3 Ensure every `UIMessageChunk` leaving the process passes the existing telemetry **redaction** layer (no secret values, no token-bearing URLs). — `LiveBus` redacts on publish; the job SSE redacts on read.

## 2. Tier-1 turns: in-process publish seam (not durable)

- [x] 2.1 Add a small in-process publish seam on the runtime singleton (survives back-end HMR, inert with no subscribers) that forwards `UIMessageChunk`s to subscribers, keyed by turn `runId`. — `src/observability/live.ts`.
- [x] 2.2 In `src/agent/loop.ts`, mint a turn `runId` at turn start, register the run (model, effort, `traceUrl`), and tap the **existing** `result.toUIMessageStream()` consumption (loop.ts:260) to forward the same chunks to the seam — no second model pass. — Implemented via `stream.tee()` (one branch assembles the turn, one forwards chunks). NOTE: text-delta coalescing-on-a-timer was intentionally skipped — chunks are forwarded as-is (passthrough), which keeps client-side `readUIMessageStream` assembly correct and is ample for a single user; revisit only if event volume becomes a problem.
- [x] 2.3 Maintain a **bounded per-turn replay buffer** for late-join (turns are not durable); publish a terminal status and deregister after `store.appendTurn(...)` so the persisted `UIMessage` exists before the client settles. — Bounded ring (`MAX_BUFFER`); `finishTurn` called after the summary/persist; finished runs kept briefly then reaped.

## 3. Tier-2 jobs: WDK durable resumable streams

- [x] 3.1 In `workflows/job.ts` and `workflows/scheduledJob.ts`, write `UIMessageChunk`s to the run's stream from steps via `getWritable()`; register/update the job in the active-runs registry keyed by the WDK run id. — Chunk writes were already in place (`getWritable<UIMessageChunk>()` + `agent.stream({ writable })`). Active jobs are derived from the durable WDK world (`workflow.workflow_runs` where status='running') rather than pushed into the in-process registry — robust across restarts and avoids double-bookkeeping.
- [x] 3.2 Confirm chunks carry stable part ids so durable re-execution/replay overwrites rather than duplicates on the client; keep stream writes lightweight. — Verified by design: the AI SDK emits `UIMessageChunk`s with stable part ids, and the client folds with `readUIMessageStream` (overwrite by id). No code change needed.
- [x] 3.3 (Optional) use a named stream namespace for progress/log channels separate from the message stream if useful. — Declined (optional): the default stream carries the `UIMessageChunk`s; no separate channel is needed yet.

## 4. Live API routes (SSE + active runs), behind the existing auth gate

- [x] 4.1 Add a streaming dashboard route returning `text/event-stream`, behind the **same session auth gate** as the rest of `/dashboard/api/**`; reject unauthenticated requests identically. — Folded into the existing `server/routes/dashboard/api/[...].ts` catch-all (reuses its exact gate verbatim) rather than a sibling route that could be shadowed; `live/stream` returns an SSE `Response`.
- [x] 4.2 For **turns**: on connect, replay the bounded buffer for the requested run then tail the in-process seam; close cleanly on disconnect. — `liveStreamTurn` (subscribe → replay + tail; `cancel()` unsubscribes).
- [x] 4.3 For **jobs**: read by run id via `getRun(jobRunId).getReadable({ startIndex })` (negative `startIndex` for late-join) and pipe to SSE. — `liveStreamJob` (`startIndex: -200`). Multi-reader behavior left to manual verification (see 9.4).
- [x] 4.4 Add a lightweight `/dashboard/api/live/active` JSON endpoint returning the active-runs snapshot for the home indicator's first paint. — `DashboardData.activeRuns()`.
- [x] 4.5 Confirm the live routes carry no control affordance and expose no secret values (manual + redaction unit check). — Only GET reads; chunks redacted; redaction unit-tested in `live.unit.test.ts`.

## 5. Front-end live data layer (reuse AI SDK primitives, not `useChat`)

- [x] 5.1 Add `useLiveRun(runId)` wrapping `EventSource` (turns) / `getReadable` via the job SSE (jobs), folding chunks with `readUIMessageStream` into a live `UIMessage` + run metadata (connect, auto-reconnect, snapshot-then-tail). Add `useActiveRuns()` for the home indicator. — `app/components/live.ts`.
- [x] 5.2 Extend `app/types.ts` to reuse AI SDK `UIMessage`/part types + the `Run`/active-runs types; extend `app/api.ts`/wiring with the active-runs fetch and the SSE stream. — `LiveRun`/`ActiveRunsView` in types; EventSource hits `/dashboard/api/live/stream` directly.
- [x] 5.3 Reconciliation: on run completion, the streamed `UIMessage` already equals the persisted turn; refetch `/conversation/thread` to settle defensively. — `ThreadPage` reloads on `done` and stops rendering the live trajectory.

## 6. Conversation view rework

- [x] 6.1 Render the thread as a **chronological, auto-stick-to-bottom chat** (`use-stick-to-bottom`) in `app/pages/Conversation.tsx`: messages oldest→newest in a scroll region pinned to the newest as it streams, with a "↓ latest" jump button when scrolled up. (Superseded the inverted newest-at-top layout — it read poorly as text streamed in. Required a full-height shell: `Layout` is now a `h-dvh` flex column with a pinned masthead and a scrolling `main`.)
- [x] 6.2 Build a shared `<RunView>` / `<MessageParts>` that renders the `UIMessagePart` union (thinking/scratch `text`, `reasoning`, the delivered `send_message` text inline, and other `tool-*` calls) plus a live status bar (status, elapsed, step count, live token usage incl. cache read/write, model/effort, Langfuse trace link). Tool **arguments and results are pretty-printed JSON in a Base UI drawer** (not inline) to keep the thread uncluttered; no rule/divider lines (terminal aesthetic). Reused by turns and jobs. — `app/components/RunView.tsx`.
- [x] 6.3 Pin the in-flight turn at the top via `useLiveRun`, updating live, then settling to the persisted turn; ensure no error when idle (most-recent persisted activity only).
- [x] 6.4 Keep the view strictly observe-only — no send/cancel/retry/edit anywhere in the step UI.

## 7. Home-page live indicator

- [x] 7.1 In `app/pages/Home.tsx`, add an "active now" banner driven by `useActiveRuns()` that is absent when nothing runs and never deep-links to a non-existent run.
- [x] 7.2 Deep-link each active run to its live view (Conversation thread for turns, job run view for jobs); support multiple concurrent active runs.

## 8. Background-job live view reuse

- [x] 8.1 Render an actively-running Tier-2 job with the shared `<RunView>` from `useLiveRun(jobRunId)` (steps, tool calls/results, status, elapsed, live token usage). — `JobRunPage` in `app/pages/Jobs.tsx`.
- [x] 8.2 Link running jobs from `app/pages/Jobs.tsx` and from the home indicator into the shared view; keep observe-only (no trigger/pause/cancel/retry).

## 9. Verification

- [x] 9.1 Unit-test the in-process seam + active-runs registry (subscribe/publish ordering, late-join buffer, terminal status, no-op when idle) and redaction of chunks. — `src/observability/live.unit.test.ts` (6 tests).
- [x] 9.2 Integration test (turn): drive a turn end-to-end and assert the live stream emits the same `UIMessageChunk`s and that the folded live `UIMessage` matches the persisted turn after completion. — `tests/loop.integration.test.ts` ("live streaming").
- [ ] 9.3 Integration test (job): run a Tier-2 job and assert `getReadable({ startIndex })` replays + tails its chunks, including late-join. — DEFERRED: WDK does not run on PGlite (needs real-Postgres LISTEN/NOTIFY), and the repo deliberately keeps full WDK runs off the default test gate (see `tests/durableStep.integration.test.ts`). The job write-side is pre-existing/unchanged; the read path is covered by the manual check (9.4).
- [ ] 9.4 Manual check on the devbox: open the Conversation page while Sunny processes a turn — newest-first, live steps without refresh, settles to persisted; home indicator appears and deep-links; a running job renders in the same view. Restart the devbox service after merge (HMR may serve stale code). — MANUAL (pending on-device run).
- [x] 9.5 Run `openspec validate live-conversation-streaming` and the repo checks. — `openspec validate` passes; server + dashboard typecheck clean; full unit suite green (217). `DESIGN.md` theme untouched, so no `design:lint` impact.
