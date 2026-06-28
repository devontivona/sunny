## Why

The durable-main-loop change runs every Tier-1 turn and Tier-2 job on `@workflow/ai`'s `DurableAgent` (Vercel AI SDK v6). AI SDK **v7** ships `WorkflowAgent` as the first-class successor and **deprecates `DurableAgent`**, so we are on a sunsetting primitive. Migrating now lets us (a) stay on a supported runtime, (b) **de-hand-roll** patterns we built by hand around `DurableAgent` — per-thread serialization, mid-turn steering, exactly-once delivery, and client streaming — by adopting v7's first-class equivalents, and (c) **fix the Langfuse per-step replay re-emission** that currently makes durable conversation traces noisy (a single turn emits ~8 duplicate `send_message` spans because the workflow runtime replays its orchestration body on every resume).

## What Changes

- **BREAKING (deps):** bump `ai` v6 → v7 (`ai@7`, `@ai-sdk/anthropic@4`) and replace `@workflow/ai` `DurableAgent` with **`@ai-sdk/workflow` `WorkflowAgent`** (`@ai-sdk/workflow@1`, stable). **Keep** `workflow` + `@workflow/world-postgres` — `WorkflowAgent` runs on the *same* durable runtime, so this is a package swap, not a runtime change. Move telemetry to `@ai-sdk/otel` + `registerTelemetry`.
- Replace `DurableAgent` with `WorkflowAgent` in `workflows/conversation.ts`, `workflows/job.ts`, `workflows/scheduledJob.ts`, and adapt the shared turn helpers + the model test seam (`mockSequenceModel`/`@workflow/ai/test`).
- **Adopt v7 first-class capabilities to retire hand-rolled code where the evaluation confirms parity** (decided in design.md). Candidate retirements: mid-turn steering/message-queueing, exactly-once side-effects, client streaming (potentially retiring the LiveBus bridge in favor of v7 resumable streams / `WorkflowChatTransport`), and reasoning-block handling.
- **Fix the Langfuse replay re-emission** so each turn produces a single clean trace (no replay-duplicated spans) — via v7's tracing if it suppresses replay telemetry, else a documented OTel-pipeline dedupe.
- Keep app-specific behavior unchanged: the explicit `send_message` output model, the delivery-recovery backstop (D-MG8), per-thread session grouping, adaptive thinking, prompt caching.

This change is **primarily an implementation migration** — it preserves existing conversational behavior (durable, idempotent, steerable turns; durable jobs) and swaps the engine beneath it; the one requirement-level change is trace cleanliness.

## Capabilities

### New Capabilities
<!-- none — this is a migration; no new user-facing capability -->

### Modified Capabilities
- `durable-execution`: the "conversational turns are observable on the durable runtime" requirement gains a guarantee that each turn produces a **single clean trace** (no replay-duplicated per-step spans), and the runtime primitive is the supported v7 `WorkflowAgent` rather than the deprecated `DurableAgent`.

## Impact

- **Dependencies:** `ai` (v6→v7), `@ai-sdk/anthropic` (3→4), `@workflow/ai`→`@ai-sdk/workflow@1`, add `@ai-sdk/otel`; `workflow`/`@workflow/world-postgres` unchanged. **Unblocked today** (`@ai-sdk/workflow@1.0.4` is stable on the same runtime); the real risk is world-interop, not availability — see design.
- **Code:** `workflows/*.ts` (agent construction + streaming), `src/agent/{durableRouter,turnModel,turn,recovery,delivery,instructions,sendMessageSpec}.ts`, the model test seam, `tests/workflow/**`, `vitest.workflow.config.ts` / `vitest.eval.config.ts`, and the eval harness.
- **Observability:** `src/observability/{instrumentation,tracePromotion}.ts` — the trace-promotion processor and/or a new replay-dedupe step.
- **Dashboard:** potentially `src/observability/live.ts` (LiveBus) + the dashboard SSE route + client hooks, IF v7 resumable streams let conversations stream straight off the run (retiring the bridge).
- **Risk:** a breaking dependency bump on the agent runtime that just shipped to production; mitigated by the durable-main-loop test infra (the `@workflow/vitest` Local-World suite + the loopback channel) carrying over to validate parity, and by gating the rollout behind the same per-turn-run boundary.
