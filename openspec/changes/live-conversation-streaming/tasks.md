## 1. Shared run model & wire (AI SDK UIMessage)

- [ ] 1.1 Define the unified `Run` model (`{ runId, kind: 'turn' | 'job', threadId?, jobName?, label, status, startedAt, model, effort, steps, usage, traceUrl }`) and reuse the AI SDK `UIMessage`/`UIMessageChunk`/`UIMessagePart` types as the canonical live wire and render model (no bespoke event union). Run-level metadata that isn't a message part rides via `UIMessage.metadata` + the registry.
- [ ] 1.2 Implement an in-memory **active-runs registry** (add on start, update on event/heartbeat, reap on finish or TTL) on the runtime singleton; expose a snapshot for connect-time + the home indicator.
- [ ] 1.3 Ensure every `UIMessageChunk` leaving the process passes the existing telemetry **redaction** layer (no secret values, no token-bearing URLs).

## 2. Tier-1 turns: in-process publish seam (not durable)

- [ ] 2.1 Add a small in-process publish seam on the runtime singleton (survives back-end HMR, inert with no subscribers) that forwards `UIMessageChunk`s to subscribers, keyed by turn `runId`.
- [ ] 2.2 In `src/agent/loop.ts`, mint a turn `runId` at turn start, register the run (model, effort, `traceUrl`), and tap the **existing** `result.toUIMessageStream()` consumption (loop.ts:260) to forward the same chunks to the seam — no second model pass; coalesce text deltas on a short timer.
- [ ] 2.3 Maintain a **bounded per-turn replay buffer** for late-join (turns are not durable); publish a terminal status and deregister after `store.appendTurn(...)` so the persisted `UIMessage` exists before the client settles.

## 3. Tier-2 jobs: WDK durable resumable streams

- [ ] 3.1 In `workflows/job.ts` and `workflows/scheduledJob.ts`, write `UIMessageChunk`s to the run's stream from steps via `getWritable()` (writes happen in steps, not the deterministic body); register/update the job in the active-runs registry keyed by the WDK run id.
- [ ] 3.2 Confirm chunks carry stable part ids so durable re-execution/replay overwrites rather than duplicates on the client; keep stream writes lightweight.
- [ ] 3.3 (Optional) use a named stream namespace for progress/log channels separate from the message stream if useful.

## 4. Live API routes (SSE + active runs), behind the existing auth gate

- [ ] 4.1 Add a streaming dashboard route `server/routes/dashboard/api/live/...` returning `text/event-stream`, behind the **same session auth gate** as the rest of `/dashboard/api/**`; reject unauthenticated requests identically.
- [ ] 4.2 For **turns**: on connect, replay the bounded buffer for the requested run then tail the in-process seam; close cleanly on disconnect.
- [ ] 4.3 For **jobs**: read by run id via `getRun(jobRunId).getReadable({ startIndex })` (negative `startIndex` for late-join) and pipe to SSE; verify multiple concurrent readers, and fan out through the seam if direct multi-reader is unsupported.
- [ ] 4.4 Add a lightweight `/dashboard/api/live/active` JSON endpoint returning the active-runs snapshot for the home indicator's first paint.
- [ ] 4.5 Confirm the live routes carry no control affordance and expose no secret values (manual + redaction unit check).

## 5. Front-end live data layer (reuse AI SDK primitives, not `useChat`)

- [ ] 5.1 Add `useLiveRun(runId)` wrapping either `EventSource` (turns) or `WorkflowChatTransport`/`getReadable` (jobs), folding chunks with `readUIMessageStream` into a live `UIMessage` + run metadata (connect, auto-reconnect, snapshot-then-tail). Add `useActiveRuns()` for the home indicator. Both parallel to the existing `useAsync`.
- [ ] 5.2 Extend `app/types.ts` to reuse AI SDK `UIMessage`/part types + the `Run`/active-runs types; extend `app/api.ts` with the active-runs fetch and the SSE/transport wiring.
- [ ] 5.3 Reconciliation: on run completion, the streamed `UIMessage` already equals the persisted turn; optionally refetch `/conversation/thread` to settle defensively.

## 6. Conversation view rework

- [ ] 6.1 Render the thread **reverse-chronological (newest first)**, top-down, in `app/pages/Conversation.tsx`.
- [ ] 6.2 Build a shared `<RunView>` that renders the `UIMessagePart` union (thinking/scratch `text`, `tool-*` calls + results/errors, `reasoning`, `step-start`) plus a live status bar (status, elapsed, step count, live token usage incl. cache read/write, model/effort, Langfuse trace link). Reused by both turns and jobs.
- [ ] 6.3 Pin the in-flight turn at the top via `useLiveRun`, updating live, then settling to the persisted turn; ensure no error when idle (most-recent persisted activity only).
- [ ] 6.4 Keep the view strictly observe-only — no send/cancel/retry/edit anywhere in the step UI.

## 7. Home-page live indicator

- [ ] 7.1 In `app/pages/Home.tsx`, add an "active now" banner driven by `useActiveRuns()` that is absent (or explicit idle) when nothing runs and never deep-links to a non-existent run.
- [ ] 7.2 Deep-link each active run to its live view (Conversation thread for turns, job run view for jobs); support multiple concurrent active runs.

## 8. Background-job live view reuse

- [ ] 8.1 Render an actively-running Tier-2 job with the shared `<RunView>` from `useLiveRun(jobRunId)` (steps, tool calls/results, status, elapsed, live token usage).
- [ ] 8.2 Link running jobs from `app/pages/Jobs.tsx` and from the home indicator into the shared view; keep observe-only (no trigger/pause/cancel/retry).

## 9. Verification

- [ ] 9.1 Unit-test the in-process seam + active-runs registry (subscribe/publish ordering, late-join buffer, TTL reaping, no-op when idle) and redaction of chunks.
- [ ] 9.2 Integration test (turn): drive a turn end-to-end and assert the SSE stream emits the same `UIMessageChunk`s and that the folded live `UIMessage` matches the persisted turn after completion.
- [ ] 9.3 Integration test (job): run a Tier-2 job and assert `getReadable({ startIndex })` replays + tails its chunks, including late-join.
- [ ] 9.4 Manual check on the devbox: open the Conversation page while Sunny processes a turn — newest-first, live steps without refresh, settles to persisted; home indicator appears and deep-links; a running job renders in the same view. Restart the devbox service after merge (HMR may serve stale code).
- [ ] 9.5 Run `openspec validate live-conversation-streaming` and the repo checks (incl. the `DESIGN.md` linter if any theme tokens were touched).
