## Context

The dashboard (React 19 SPA + Nitro server, single unified Vite dev process) renders the Conversation page from a one-shot `apiGet('/conversation/thread?id=…')` against `server/routes/dashboard/api/[...].ts` → `DashboardData.thread()`, which reads the `messages` table (`timestamp DESC, limit 50`) and projects each row's `payload` (an AI SDK `UIMessage`) into a `ConversationMessage`. It is static and oldest-first; nothing updates while Sunny works.

Two facts shape this design:

- **Sunny already speaks `UIMessage`.** The persisted `messages.payload` is an AI SDK `UIMessage`, and `src/agent/loop.ts` already produces the turn by consuming `result.toUIMessageStream()` with `readUIMessageStream(...)` (loop.ts:260). The AI SDK `UIMessagePart` union (`text`, `tool-*`, `reasoning`, `step-start`) is exactly the per-step / tool-call shape the proposal needs. So we adopt `UIMessageChunk` as the live wire and `UIMessage` as the render model rather than inventing a parallel event schema.
- **The Workflow DevKit gives durable, resumable streams — but only on workflow runs.** Every WDK run has a durable default stream: a step writes chunks via `getWritable<T>()`, and an HTTP route reads them via `getRun(id).getReadable({ startIndex })` (negative `startIndex` replays the last N chunks for late-join/reconnect). It is event-sourced into the Postgres workflow world (no Redis), survives process restart, and `@workflow/ai` ships a `WorkflowChatTransport` that does the reconnect-by-`x-workflow-run-id` handshake. **Streams cannot exist standalone** — they are exclusively tied to a workflow run.

Sunny's activity is produced in **one long-lived worker process**, across two tiers:
- **Tier-1 turns** — `dispatcher.ts` → `loop.ts`, run **in-process** (deliberately, for latency and to keep the byte-stable cached system prefix). These are **not** workflow runs, so WDK durable streams cannot reach them without wrapping each turn in a durable workflow (rejected — see Non-Goals).
- **Tier-2 jobs** — `workflows/job.ts` / `workflows/scheduledJob.ts`, **are** WDK workflow runs, so they get durable resumable streams for free.

There is no event bus / WebSocket / SSE / polling today; every page uses the `useAsync` one-shot fetch hook. Observability already exists via Langfuse/OTel with a redaction layer. This design adds a read-only live path that reuses the AI SDK UI primitives, leans on WDK streams where they apply, and bridges only the in-process gap with a thin custom seam.

## Goals / Non-Goals

**Goals:**
- Reverse the Conversation view to most-recent-first, with the in-flight turn pinned at the top.
- Render each turn/job as a trajectory using AI SDK `UIMessage` parts: thinking/scratch, tool calls (name + args), results/errors, step boundaries.
- Stream in-flight turn and job activity to the open view with no manual refresh, then settle to the persisted record.
- Home-page "active now" indicator deep-linking to the live run; reuse the same live run view for actively-running Tier-2 jobs.
- Per-run live debug state: status, elapsed, step count, live token usage (incl. cache read/write), model/effort, Langfuse trace link.
- Stay strictly observe-only and leak no secrets.

**Non-Goals:**
- No control affordances (send/cancel/retry/edit).
- **Do not make Tier-1 turns durable workflow runs.** The two-tier design keeps conversational turns in-process for latency and cached-prefix stability; adding per-turn durability just for observability is out of scope. (Chosen: hybrid transport — see Decisions.)
- No new persistence / DB migration for turns; turn live events are ephemeral.
- No change to delivery logic, to what trajectories capture, or to the cached system prefix.
- No live Health/Schedules streaming in this change (Activity gains in-flight run state only).
- No `useChat` as the page-level abstraction (the dashboard is multi-thread, observational, and never sends) — we reuse its primitives, not the hook itself.

## Decisions

### Decision: `UIMessage` / `UIMessageChunk` is the canonical wire and render model
The live wire carries AI SDK `UIMessageChunk`s; the front-end folds them into `UIMessage`s with `readUIMessageStream` and renders the `UIMessagePart` union with shared part components. The persisted `payload` is the same `UIMessage`, so the static view and the live view share one renderer.

- **Why:** the loop already emits a `UIMessageStream`; parts already model thinking/tool-call/result/step-start; the persisted record is already a `UIMessage`. A bespoke event union would re-derive all of this and create a second schema to keep in sync. This is the single biggest reuse win.
- **Consequence:** the earlier "custom event union" idea is dropped. Run-level metadata not expressible as message parts (status, elapsed, live usage, model/effort, trace link) rides alongside via `UIMessage.metadata` and the active-runs registry, not a separate event grammar.

### Decision: Tier-2 jobs stream over WDK durable resumable streams
Jobs (already WDK runs) write `UIMessageChunk`s to the run's default stream from their steps via `getWritable()`; the dashboard reads them by run id via `getRun(jobRunId).getReadable({ startIndex })`, served to the browser as SSE. The client uses `WorkflowChatTransport` (or the same `readUIMessageStream` consumer) to attach/reconnect with `startIndex: -N` for late-join.

- **Why:** durable, resumable, replayable, survives process restart, late-join for free — backed by the Postgres world we already run, **no Redis, no hand-built replay buffer**. Strictly better than an in-memory bus for the job half.
- **Note:** write chunks from within steps (the SDK requires stream writes to happen in steps, not the deterministic workflow body); progress/log channels can use a named stream namespace if we want to separate them from the message stream.

### Decision: Tier-1 turns stream over a thin in-process publish → SSE (same `UIMessageChunk` wire)
Because in-process turns are not workflow runs, we keep a small in-process publish seam: tap the loop's existing `toUIMessageStream()` consumption and forward the same `UIMessageChunk`s to subscribers, exposed over SSE under `/dashboard/api/live`. It holds a **bounded per-turn replay buffer** for late-join (turns are not durable, so this is the one place we buffer ourselves). The seam lives on the runtime singleton (survives back-end HMR) and is inert when no one subscribes.

- **Why:** turns deliberately avoid durability; this bridges only the in-process gap, reusing the AI SDK chunk wire so turns and jobs render identically. The seam is small and behind an interface, so if turns ever become durable runs it collapses into the WDK path.
- **Alternatives rejected:** wrapping every turn in a durable workflow (adds latency, touches the cached-prefix design — a Non-Goal); a general LISTEN/NOTIFY bus (overkill for one process).

### Decision: Unified `Run` model + active-runs registry
One `Run` concept covers both kinds: `{ runId, kind: 'turn' | 'job', threadId?, jobName?, label, status, startedAt, model, effort, steps, usage, traceUrl }`. Turn `runId` is minted at turn start (one active turn per thread, per the dispatcher's serialization); job `runId` is the WDK run id (the same id used for `getReadable`). An in-memory active-runs registry (add on start, update on event/heartbeat, reap on finish or TTL) powers the home indicator and the connect-time snapshot. This unifies the home indicator, the Conversation live view, and the job view over the same component set.

### Decision: SSE for both tiers under `/dashboard/api/live`, behind the existing auth gate
A streaming route (separate from the JSON catch-all) serves `text/event-stream` for turns (from the in-process seam) and proxies the WDK `getReadable` stream for jobs, plus a `/dashboard/api/live/active` JSON endpoint for the home indicator's first paint. All live routes sit behind the same session gate as `/dashboard/api/**`, and every chunk passes through the existing redaction layer before the wire.

- **Why SSE over WebSocket:** one-way, read-only, rides plain HTTP through the cookie gate, auto-reconnects, natively supported by H3/Nitro. (For jobs, `WorkflowChatTransport`'s reconnect uses the same GET-by-run-id shape.)

### Decision: Reconciliation is nearly free
Because the streamed `UIMessage` for a turn is the *same object* the loop persists via `appendTurn`, the live provisional turn and the stored turn converge by construction. On `finish`/run-completion the client may refetch the persisted thread to be safe, but there is no separate streamed-vs-stored schema to reconcile.

### Decision: Front-end reuses AI SDK primitives, not the `useChat` hook
- Conversation thread renders newest-first (the query already returns `timestamp DESC`); the in-flight provisional turn is prepended.
- A `useLiveRun(runId)` hook wraps either `EventSource` (turns) or `WorkflowChatTransport`/`getReadable` (jobs) and exposes the folded `UIMessage` + run metadata; a `useActiveRuns()` hook backs the home indicator. These sit parallel to the existing `useAsync`.
- A shared `<RunView>` renders the `UIMessagePart` union plus the run status bar, used by both the Conversation in-flight turn and the job view.

## Risks / Trade-offs

- **Turns are not durable; a crash loses in-flight turn events** → acceptable: the persisted turn is the source of truth and the loop persists on completion; the in-process buffer only accelerates the live view. Jobs (the long-running case where durability matters most) are durable via WDK.
- **Multiple dashboard tabs reading the same WDK job stream** → `getReadable` is expected to mint an independent event-sourced reader per call; verify multi-reader behavior during apply, and if needed fan out through the in-process seam instead of N direct `getReadable` calls.
- **Writing live chunks from job steps adds step overhead / could replay on durable re-execution** → keep stream writes lightweight and idempotent; the SDK already scopes writes to steps, and `UIMessageChunk`s carry part ids so a replay overwrites rather than duplicates on the client.
- **Two transports to maintain (SSE seam for turns, WDK stream for jobs)** → mitigated by the shared `UIMessageChunk` wire and shared `<RunView>`: only the attach/reconnect layer differs, behind `useLiveRun`.
- **Secrets on a new wire** → all chunks pass the existing redaction layer; tool args contain only `op://` refs by invariant; live routes are auth-gated identically to other dashboard data.
- **SSE connections across HMR / many tabs** → the in-process seam is a runtime singleton (survives back-end HMR); one multiplexed stream per tab bounds connections; handlers close on disconnect.

## Migration Plan

- **Additive and read-only.** New: live SSE + active-runs routes, `useLiveRun`/`useActiveRuns` hooks, shared `<RunView>`, an in-process publish seam tapped in `loop.ts`, and `getWritable()` chunk writes in the job workflows. **No DB migration** (turn events ephemeral; job streams use the existing workflow world).
- Deploy = normal merge + devbox service restart (HMR can serve stale code post-merge — restart the worker so the seam + publishers initialize).
- **Rollback:** remove the routes/components/hooks and the publish/`getWritable` calls; the seam is inert with no subscribers and no persisted schema changed.

## Open Questions

- **WDK multi-reader & retention:** confirm multiple concurrent `getReadable` readers on one job run, and how long a finished run's stream remains replayable (affects whether a just-finished job still renders live before settling to the static job view).
- **Turn replay-buffer bound:** how many recent `UIMessageChunk`s per active turn to retain for late-join without unbounded memory (start small — e.g. current step — and tune).
- **Persist `runId`/`traceUrl` into `UIMessage.metadata`:** low-cost add so completed turns/jobs link to their trace from the static view too; decide during apply.
- **Idle stream lifecycle:** keep the multiplexed SSE open while the dashboard is viewed (instant home-indicator updates) vs. open lazily only when a run is active. Leaning open-while-viewing.
