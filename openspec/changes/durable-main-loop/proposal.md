## Why

Tier-2 durable jobs (`workflows/job.ts`) are first-class durable workflow runs — visible in `npx workflow inspect runs --web` and resumable after a crash — but the Tier-1 main conversational loop (`src/agent/loop.ts`) is an in-process `ToolLoopAgent` that only emits Langfuse traces. The primary chat path, where almost all activity happens, has the weakest observability and no mid-turn crash resumability: if the worker dies 29s into a 30s multi-step turn, restart recovery re-runs it from scratch.

The two reasons this was assumed hard both fail on inspection: delivery is **not** socket-coupled (the webhook acks fast and sends are REST-by-threadId), and double-text steering maps almost 1:1 onto `DurableAgent`'s documented `prepareStep` message-queue pattern. Converting Tier 1 to a `DurableAgent` therefore buys run-level observability **and** crash-resumable turns, and lets us retire hand-rolled durability machinery (the in-process dispatcher's active-map, steer queue, and restart recovery) into the WDK runtime.

## What Changes

- Run each Tier-1 conversational turn as a WDK `DurableAgent` workflow — **one long-lived workflow run per thread** that loops on a hook, processing one turn at a time (replacing the in-process `TurnDispatcher` active-map + per-thread serialization).
- Move delivery into the workflow: `send_message` becomes a `'use step'` REST send by threadId (via `adapter.postMessage`), exactly like Tier-2 jobs' `deliver()` step. No live `Thread` handle is required inside the workflow.
- Re-plumb double-text steering: the gateway calls `resumeHook(runId, event)` instead of pushing into an in-process array; a non-blocking `hook.then(...)` listener fills an in-memory queue that the turn's `prepareStep` splice-drains at each step boundary (WDK's documented message-queueing pattern).
- Keep the typing indicator **gateway-side** and upgrade it: the gateway still receives the webhook and holds the live `Thread` handle, tails the run's output stream (the same `getWritable()` channel used for observability), and re-fires `startTyping` on each chunk until the stream closes — a strict improvement over today's single fire-at-start that never refreshes.
- Surface every Tier-1 turn in `npx workflow inspect runs --web` with per-step traces, and make turns resume from their last durable step after a crash/reboot rather than restarting.
- Considered alternative (documented in design, not adopted as the primary path): a **thin per-turn workflow shell** that registers a run for the dashboard while the tool loop stays in-process — cheaper (no per-step latency, no dispatcher rewrite) but does **not** buy mid-turn resumability.

Non-goals / must-not-regress (no spec behavior change): D-MG8 explicit send-message output model (send_message is the only voice, the delivery-recovery pass, `stay_silent`), D-MG9 one-row-per-turn persistence, Langfuse telemetry grouped by thread, byte-stable cached system prefix, and adaptive thinking.

## Capabilities

### New Capabilities
<!-- none — this reshapes existing capabilities -->

### Modified Capabilities
- `durable-execution`: The **Two-tier execution model**, **Idempotent conversational turns survive restart**, and **Double-text steering of an in-flight run** requirements change — Tier-1 turns now execute as durable per-thread workflow runs (observable via `workflow inspect`, resumable mid-turn from the last durable step), steering is delivered via `resumeHook` + `prepareStep` rather than an in-process queue, and per-message idempotency/serialization is enforced by the workflow run rather than the in-process dispatcher.
- `messaging-gateway`: The typing-indicator behavior under **Per-channel capability flags with graceful degradation** / **Direct-message delivery** changes — typing is now refreshed gateway-side from the turn's output stream across the life of a turn, and outbound delivery during a turn is a durable step (REST-by-threadId) rather than an in-process live-handle send.

## Impact

- **Code**: `src/agent/loop.ts` (becomes a `DurableAgent`-based workflow), `src/agent/dispatcher.ts` (per-thread serialization + steer queue retired into the workflow / reduced to hook routing), `src/gateway/sendblue.ts` (typing refresh from run stream; `send` path for in-turn delivery moves to a step), `src/runtime.ts` (restart recovery folds into WDK resumption), `src/agent/tools/sendMessage.ts` and other tool `execute`s (wrapped as `'use step'`). New/changed `workflows/` entry for the conversational turn.
- **Dependencies**: `@workflow/ai` (`DurableAgent`), `workflow` (`createHook`/`resumeHook`/`getWritable`/`start`), existing `@workflow/world-postgres` runtime — no new packages.
- **Runtime/perf**: each in-turn tool `execute` becomes a durable step (Postgres write + worker dispatch) on the lowest-latency surface; acceptable for a single sporadic user but a real tradeoff, weighed in design.
- **Operability**: Tier-1 turns appear in `workflow inspect` alongside Tier-2 jobs; the in-process restart-recovery path (D-DE1) is superseded by workflow resumption.
