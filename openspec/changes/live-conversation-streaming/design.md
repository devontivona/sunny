## Context

The dashboard (React 19 SPA + Nitro server, single unified Vite dev process) renders the Conversation page from a one-shot `apiGet('/conversation/thread?id=…')` against `server/routes/dashboard/api/[...].ts` → `DashboardData.thread()`, which reads the `messages` table (ordered `timestamp DESC, limit 50`) and projects each row's `payload` (an AI SDK `UIMessage`) into a `ConversationMessage` (`delivered[]`, `scratch`, `usage`, `steps`, …). It is static and oldest-first within a fetched page; nothing updates while Sunny works.

Sunny's activity is produced in two places, **both inside one long-lived worker process**:
- **Tier-1 turns** — `src/agent/dispatcher.ts` → `src/agent/loop.ts` (`createAgentRunner`). The loop calls `gateway.startTyping(threadId)`, runs a `ToolLoopAgent` (AI SDK v6, `claude-opus-4-8`), **consumes the `UIMessageStream` to completion**, extracts parts, then `store.appendTurn(...)` persists the whole `UIMessage` at the end. Persistence is end-of-turn only.
- **Tier-2 jobs** — `workflows/job.ts` / `workflows/scheduledJob.ts`, durable WDK workflows where each LLM/tool call is a durable step. Runs are recorded in `workflow.workflow_runs` / `workflow.workflow_steps`; the dashboard's `Jobs.tsx` reads them after the fact.

There is **no event bus, WebSocket, SSE, or polling** today; every page uses the `useAsync` one-shot fetch hook (`app/components/ui.tsx`). Observability already exists via Langfuse/OTel with `langfuseSessionId = threadId`, and a redaction layer keeps secrets out of every sink. The only live signal to the owner is the iMessage typing indicator.

This design adds a read-only live observability path: tap the activity Sunny already produces, publish it on an in-process bus, expose it over SSE behind the existing dashboard auth gate, and rework the Conversation page (and the running-job view, and a home indicator) to consume it.

## Goals / Non-Goals

**Goals:**
- Reverse the Conversation view to most-recent-first, with the in-flight turn pinned at the top.
- Render each turn as a trajectory: thinking/scratch, tool calls (name + args), tool results/errors, step boundaries.
- Stream in-flight turn and job activity to the open view with no manual refresh, then settle to the persisted record on completion.
- Show a home-page "active now" indicator that deep-links to the live run; reuse the same live run view for actively-running Tier-2 jobs.
- Surface live debug state per run: status, elapsed, step count, live token usage (incl. cache read/write), active model/effort, link to the Langfuse trace.
- Stay strictly observe-only and leak no secrets.

**Non-Goals:**
- No control affordances (send/cancel/retry/edit) — out of scope and forbidden by the `web-dashboard` observe-only invariant.
- No new persistence / DB migration; live events are ephemeral and derived from existing activity.
- No change to what trajectories capture, to delivery logic, or to the byte-stable cached system prefix.
- No live streaming of the Health/Schedules pages in this change (Activity gains in-flight run state only); broader live-health is deferred.
- No cross-process transport (LISTEN/NOTIFY) now — single-process in-memory bus is sufficient; the seam is abstracted so it can be swapped later.

## Decisions

### Decision: In-process `LiveBus` event bus on the runtime singleton
A single `LiveBus` (thin wrapper over Node `EventEmitter`) is created once in `src/runtime.ts` and held on the runtime singleton, alongside the gateway/scheduler/store. Both the agent loop and the job runners publish to it; the SSE route subscribes to it.

- **Why:** turns and jobs share one long-lived process, so an in-memory bus reaches both with zero infra. It is inert when no one is listening (no cost on the hot path).
- **HMR safety:** the bus lives on the runtime singleton that already survives back-end hot reload (the spec requires a front-end edit not to re-run durable startup), so subscribers aren't orphaned by HMR.
- **Alternatives:** Postgres `LISTEN/NOTIFY` (rejected: overkill for one process, adds latency/DB load); WDK tables polled by the dashboard (rejected: coarse, no sub-step granularity, laggy). The `LiveBus` is defined behind a small interface so a future multi-process split can swap the transport without touching publishers.

### Decision: Tap the existing AI SDK stream; publish parts as they arrive
The loop already consumes the `UIMessageStream`. We tap that same consumption point in `loop.ts` to publish a live event per meaningful part (step-start, text-delta, tool-input/tool-call, tool-result/error, usage, status) **in addition to** the existing accumulation-and-`appendTurn`. No second model pass; publishing is a side-channel on data already flowing.

- **Why:** zero added LLM cost, naturally ordered, and the event shape can mirror `UIMessage` parts so the client reconciles cleanly.
- For **jobs**, publish from the job runner's stream consumption as **best-effort, non-durable side effects** (see Risks — WDK replay), keyed by the WDK run id.
- **Coalescing:** text deltas are throttled/coalesced (e.g. batched on a short timer) before publish to avoid event floods; tool/step/status events are sent eagerly.

### Decision: Unified `Run` model + active-runs registry
Introduce one `Run` concept covering both kinds: `{ runId, kind: 'turn' | 'job', threadId?, jobName?, label, status, startedAt, model, effort, steps, usage, traceUrl }`. Turn `runId` is minted at turn start (one active turn per thread, per the dispatcher's per-thread serialization); job `runId` is the WDK run id. The `LiveBus` maintains an in-memory **active-runs registry** (add on start, update on events, remove shortly after finish), which powers the home indicator and lets a late-joining client get a snapshot.

- **Why:** the Conversation live view, the running-job view, and the home indicator all need "what is active and what is its state" — one model serves all three and keeps the front-end components shared.

### Decision: Single multiplexed SSE stream under `/dashboard/api/live`
Add one SSE endpoint (`text/event-stream`) that, on connect, emits a snapshot of active runs + a bounded per-run replay buffer, then tails the `LiveBus`. Events carry `runId`; the client filters by the run(s) it's displaying. A separate lightweight `/dashboard/api/live/active` JSON endpoint backs the home indicator's initial paint (then it shares the stream for updates).

- **Why SSE over WebSocket:** the channel is one-way and read-only; SSE rides plain HTTP through the existing cookie-auth gate, auto-reconnects in the browser, and is natively supported by H3/Nitro streaming. WebSocket's duplex/extra infra buys nothing here.
- **Why multiplexed (one stream) over per-run streams:** simpler connection lifecycle, one auth check, trivial home-indicator + multi-run support; the client already knows which runId it cares about. Per-run streams would multiply connections and reconnection logic.
- **Auth:** the live routes sit behind the same session gate as the rest of `/dashboard/api/**`; an unauthenticated request gets the same denial as any other dashboard API call. Served via a dedicated streaming route so the existing JSON catch-all stays untouched.
- **Redaction:** every event payload passes through the existing telemetry redaction before hitting the wire (defensive — tool args already exclude secret values by invariant, but `op://` refs/URLs are filtered the same as other sinks).

### Decision: Reconcile by settling to the persisted record
The streamed in-flight turn is a *provisional* object in the client. On `run-finished`, the client refetches the persisted thread via the existing `/conversation/thread` endpoint and replaces the provisional turn with the stored one. This guarantees the spec's "streamed state settles to the persisted record with no divergence," and makes late-join / dropped-event cases self-healing (the persisted record is the source of truth; the stream is an accelerator).

- **Why:** avoids trying to make the stream perfectly lossless; the DB remains authoritative, the stream just makes it feel live.

### Decision: Front-end — reverse order, pinned live turn, shared run-view component
- Conversation thread view renders newest-first (the existing query already returns `timestamp DESC`; the page just renders top-down and prepends the in-flight provisional turn).
- A new `useLiveRun(runId)` / `useActiveRuns()` hook wraps `EventSource`, parallel to `useAsync`, managing connect/reconnect/snapshot/tail.
- A shared `<RunView>` (steps, tool calls, results, status/elapsed/usage/model, trace link) is used by both the Conversation in-flight turn and the running-job view, satisfying "reuse the live view for background jobs."
- `Home.tsx` gains an active-runs banner (absent when idle) with deep links; `Jobs.tsx` links a running job into the shared run view.

## Risks / Trade-offs

- **WDK durable replay double-emits job events** → publish job live events as best-effort, non-durable side effects (outside durable-step semantics), tag each event with a monotonic per-run sequence id, and have the client dedupe/replace by sequence. Worst case a replay re-emits and the client idempotently overwrites; the persisted record still settles correctly.
- **Event flood from token/text deltas** → coalesce text deltas on a short timer and send a single rolling "in-progress text" rather than per-token events; the bus is a no-op when there are no subscribers, so idle turns cost nothing.
- **Stale/false "active" indicator if a run dies without a finish event** (crash, process restart) → registry entries carry `startedAt` and a heartbeat/last-update; entries that go stale past a TTL are reaped, and the home indicator treats no recent update as "not active." On reconnect the client re-syncs from the snapshot.
- **Future multi-process job execution would blind the in-memory bus** → the bus is behind a small publish/subscribe interface; swapping to Postgres `LISTEN/NOTIFY` later is localized to the bus implementation and SSE route, not the publishers or the front-end.
- **Leaking secrets through tool args / errors on a new wire** → route all event payloads through the existing redaction layer; tool arguments never contain secret values by invariant (only `op://` refs), and the live wire is auth-gated identically to other dashboard data.
- **SSE connections held open across HMR / many tabs** → the bus is a runtime singleton (survives back-end HMR); the SSE handler closes cleanly on client disconnect and there is a single multiplexed stream per tab, bounding connection count.

## Migration Plan

- Purely **additive and read-only**: new `LiveBus`, new SSE + active-runs routes, new front-end hook/components, publish calls inserted at the loop's existing stream-consumption point and in the job runners. **No DB migration** (no new tables; events are ephemeral).
- Deploy is a normal merge + devbox service restart (HMR can serve stale code after merges — restart the worker so the new bus + publishers initialize).
- **Rollback:** remove the routes/components and the publish calls; the `LiveBus` is inert with no subscribers, and nothing in the persisted data model changed, so there is no data to migrate back.

## Open Questions

- **Replay buffer bound:** how many recent events per active run to retain for a late-joining client (enough to reconstruct the in-flight turn without unbounded memory)? Start small (e.g. last N events or last step) and tune.
- **Turn `runId` exposure:** should the persisted `UIMessage.metadata` also record the `runId`/`traceUrl` so a completed turn links to its trace from the static view too? Low-cost add; decide during apply.
- **Idle stream lifecycle:** keep the multiplexed SSE connection open while idle (simpler, supports instant home-indicator updates) vs. open it lazily only when something is active. Leaning open-while-viewing-dashboard, closed otherwise.
