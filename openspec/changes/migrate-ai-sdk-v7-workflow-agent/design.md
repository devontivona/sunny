## Context

durable-main-loop put every Tier-1 turn (`workflows/conversation.ts`) and Tier-2 job (`workflows/job.ts`, `scheduledJob.ts`) on `@workflow/ai`'s `DurableAgent` (AI SDK `ai@6.0.206`, `@ai-sdk/anthropic@3`), on the Workflow DevKit runtime (`workflow` + `@workflow/world-postgres`). AI SDK **v7** ships `WorkflowAgent` (`@ai-sdk/workflow@1.0.4`, stable) as the supported successor and **deprecates `DurableAgent`**.

Around `DurableAgent` we hand-rolled: a gateway-side per-thread serial worker (`durableRouter`), mid-turn steering via a store read in `prepareStep` (`loadSteers` — chosen to avoid the DevKit hook FIFO **parking bug**), exactly-once delivery (a memoized `sendStep` `'use step'`), a `processedAt` watermark for cross-message idempotency, client streaming via a LiveBus bridge, and a reasoning-block strip (Anthropic rejects re-sent thinking). We also carry a known **observability defect**: the `workflow` runtime replays the orchestration body on each resume, re-emitting non-journaled OTel spans, so one turn shows ~8 duplicate `send_message` spans in Langfuse.

**Key correction from research:** the migration is **not** gated on `@workflow/ai` adding `ai@7` (it won't). The v7 path is a *different package* — `@ai-sdk/workflow` `WorkflowAgent` — running on the **same** `workflow`/`@workflow/world-postgres` runtime we already use. So this is a package swap, and the durable-main-loop test infra (`@workflow/vitest` Local-World suite + the loopback channel) carries over to validate parity.

## Goals / Non-Goals

**Goals:**
- Replace `DurableAgent` with `WorkflowAgent` and bump `ai` v6→v7 across the 3 workflow call sites, preserving conversational + job behavior.
- Adopt v7 first-class capabilities to **delete** hand-rolled code where parity is proven (exactly-once steps; potentially the LiveBus chunk-bridge in favor of `WorkflowChatTransport`/resumable streams).
- **Fix the Langfuse per-step replay re-emission** so each turn is a single clean trace.
- Carry the existing test infra forward as the parity oracle.

**Non-Goals:**
- No change to the explicit `send_message` output model (D-MG8), the delivery-recovery backstop, per-thread session grouping, adaptive thinking, or prompt caching.
- No change to the `workflow`/`@workflow/world-postgres` durable runtime or the Postgres store/schema (beyond what D-MG9 persistence rework forces).
- Not retiring per-thread serialization or the idempotency watermark (these are app orchestration, not agent concerns).

## Decisions

**D1 — Package swap, same runtime.** `@workflow/ai`→`@ai-sdk/workflow@1`; `ai@6→7`; `@ai-sdk/anthropic@3→4`; add `@ai-sdk/otel`; **keep** `workflow@^4.2.x` + `@workflow/world-postgres@^4.2.0` (`@ai-sdk/workflow` dev-deps `workflow@4.2.4`, so versions align). Use the v7 codemod for the mechanical `ai` renames; do the `WorkflowAgent` swap by hand. *Alternative — stay on `DurableAgent`:* rejected (deprecated; we'd diverge from the supported path and never get the v7 improvements).

**D2 — WorkflowAgent call shape + rebuild D-MG9 persistence.** `new WorkflowAgent({ model, instructions, tools })` + `await agent.stream({ messages, writable: getWritable<ModelCallStreamPart>() })`, converting at the response boundary with `createModelCallToUIChunkTransform()`. **`collectUIMessages` is removed in v7**, so our D-MG9 one-row-per-turn persistence (today: `collectUIMessages: true` → `result.uiMessages` in `conversation.ts`) must be rebuilt on the v7 model: store `UIMessage[]` as source of truth, `convertToModelMessages(...)` before each call, derive the persisted turn from `result.messages` (`ModelMessage[]`). *Alternative — keep collecting UI chunks ourselves from the writable:* possible but re-hand-rolls what v7's transform gives for free; only fall back if the transform loses the scratch/send classification we need.

**D3 — De-hand-roll only where proven first-class.** Per the research map:
- **Keep:** per-thread serial worker, `processedAt` watermark, delivery-recovery backstop (all app-level).
- **Already first-class (no change needed):** exactly-once side-effects — `WorkflowAgent` wraps tools as `'use step'` with journaling + retry, which is exactly our `sendStep` model.
- **Evaluate + likely adopt:** client streaming. `WorkflowChatTransport` + durable `getReadable({ startIndex })` reconnect (`x-workflow-run-id`) is first-class; the dashboard could read the run stream directly and retire the LiveBus **chunk-bridging** — but the **thread→active-run tracking** the LiveBus also provides stays app-side (the reason we kept it in durable-main-loop). Net: a *partial* de-hand-roll, decided by a dashboard spike.
- **Verify (likely keep):** mid-turn steering — no documented safe message-queue primitive on `WorkflowAgent`; DevKit hooks still carry the parking hazard. Keep `loadSteers` unless a v7 primitive proves safe.
- **Verify (likely keep):** reasoning strip — v7 adds top-level `reasoning`/`reasoning-file`; whether `convertToModelMessages` avoids re-sending Anthropic thinking blocks needs a **live check**.

**D4 — Langfuse fix is a distinct workstream, gated on empirical evidence.** The re-emission is a `workflow`-runtime behavior; `WorkflowAgent` runs on the same runtime, so it **may not vanish**. Sequence: (1) migrate, then **drive a turn and inspect the trace** — WorkflowAgent journals tool calls as `'use step'`, so journaled spans return cached on replay and may stop duplicating; (2) **if wrapper spans still re-emit**, add an OTel `SpanProcessor`/`Sampler` that drops spans created within a `workflow.replay` context, re-hosted under the new `@ai-sdk/otel` `registerTelemetry` pipeline (where `TracePromotingSpanProcessor` + `RedactingSpanProcessor` must move anyway); (3) pursue an upstream `workflow` suppress-on-replay knob in parallel. Do **not** claim the migration fixes traces until step 1 confirms.

**D5 — OTel re-host.** v7 moves telemetry out of `ai` into `@ai-sdk/otel` with `registerTelemetry(new OpenTelemetry(...))` and `experimental_telemetry`→`telemetry`. `instrumentation.ts` + our two custom processors re-attach to that pipeline; the trace-promotion attribute names (`ai.telemetry.*`) need re-confirmation against v7's emitted attributes.

**D6 — Test seam.** `@workflow/ai/test` `mockSequenceModel` has no `@ai-sdk/workflow` equivalent; move the `turnModel.ts` seam (and the workflow + eval suites) to `ai`'s `MockLanguageModelV3`. Opportunity: fix the history-indexing quirk (response chosen by assistant-message count) that forced fresh-thread isolation in the loopback driver.

**D7 — Spike before commit.** The biggest unknown is `@workflow/world-postgres` (DevKit namespace) running `@ai-sdk/workflow` (Vercel) workflows. Both target `workflow@4.2.x` so it *should* interop, but it's our production durable store — **spike this first** on a throwaway workflow before touching `conversation.ts`.

## Risks / Trade-offs

- **World interop unverified (biggest)** → spike a trivial `@ai-sdk/workflow` `WorkflowAgent` run against `@workflow/world-postgres` before any real migration; abort/escalate if it doesn't run on our world.
- **`collectUIMessages` removal breaks D-MG9 persistence** → rebuild on `UIMessage[]`-as-truth + `convertToModelMessages`; cover with the existing workflow tests (delivery/persist/mark, exactly-once-on-replay) before cutover.
- **Breaking dep bump on a just-shipped production runtime** → gate behind the same per-turn-run boundary; validate with the Local-World suite + loopback live smoke before flipping; rollback = revert the change (back to `DurableAgent`).
- **Langfuse may not auto-clean** → treated as a gated sub-workstream (D4), not assumed.
- **Steering / reasoning have no documented v7 primitive** → keep hand-rolled; only delete on proof.
- **OTel attribute drift** → re-confirm `TracePromotingSpanProcessor` against v7's emitted span attributes (trace name/session/io could regress silently).

## Migration Plan

1. **Spike** (D7): `@ai-sdk/workflow` `WorkflowAgent` on `@workflow/world-postgres` — confirm a turn runs + journals on our world.
2. **Deps:** bump `ai`/`@ai-sdk/anthropic`, add `@ai-sdk/workflow` + `@ai-sdk/otel`, run the v7 codemod, resolve type breaks.
3. **Agents:** swap `DurableAgent`→`WorkflowAgent` in the 3 workflows; rebuild D-MG9 persistence (D2); migrate the model test seam (D6). Green the `@workflow/vitest` suite.
4. **OTel re-host** (D5): move instrumentation + the two processors to `registerTelemetry`; confirm trace name/session/io still promote.
5. **Langfuse** (D4): drive a live turn, inspect the trace; add the replay-span filter only if duplication persists.
6. **Client streaming** (D3): spike retiring the LiveBus chunk-bridge via `WorkflowChatTransport`; adopt only if it cleanly subsumes the dashboard pane (keep thread→run tracking app-side).
7. **Verify + cutover:** typecheck + all lanes + loopback live smoke (default-durable, real + deterministic), then merge. Rollback = git revert.

## Open Questions

- Does `@ai-sdk/workflow` `WorkflowAgent` expose a **safe in-flight steering / message-queue** primitive, or does `loadSteers` stay?
- **Empirically**, does `WorkflowAgent` on our runtime still re-emit per-step spans on replay (the Langfuse defect), or does its heavier step-journaling fix it?
- Does `@workflow/world-postgres` run `@ai-sdk/workflow` workflows without issue (D7 spike)?
- Under v7's content model, does `convertToModelMessages` avoid re-sending Anthropic **thinking blocks**, or do we keep the strip?
- Does `WorkflowChatTransport` + resumable streams fully cover the dashboard conversation pane (so the LiveBus chunk-bridge can go), or only partially?
