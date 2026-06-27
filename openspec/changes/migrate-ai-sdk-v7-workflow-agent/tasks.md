## 1. Spike — gate before committing (D7)

- [ ] 1.1 Stand up a throwaway `@ai-sdk/workflow` `WorkflowAgent` workflow and run it against our `@workflow/world-postgres` world (a scratch test in the `@workflow/vitest` Local World, then one run against real Postgres). Confirm it executes, journals steps, and resumes — i.e. the Vercel `@ai-sdk/workflow` workflow interops with the DevKit `@workflow/*` world.
- [ ] 1.2 If interop fails, STOP and escalate (record the failure mode); the rest of the change is gated on this.

## 2. Dependencies

- [ ] 2.1 Bump `ai` 6→7 and `@ai-sdk/anthropic` 3→4; add `@ai-sdk/workflow@1` + `@ai-sdk/otel`; remove `@workflow/ai`. Keep `workflow` + `@workflow/world-postgres`. Run the official v7 codemod for mechanical `ai` renames; resolve remaining type breaks.
- [ ] 2.2 Inventory v6→v7 breaks across our usage (`streamText`/tools/`providerOptions`/`stopWhen`/`UIMessage`/`convertToModelMessages`, Anthropic provider) and fix them.

## 3. WorkflowAgent migration (the 3 workflow call sites)

- [ ] 3.1 `workflows/conversation.ts`: replace `DurableAgent` with `new WorkflowAgent({ model, instructions, tools })` + `agent.stream({ messages, writable: getWritable<ModelCallStreamPart>() })`; add `createModelCallToUIChunkTransform()` at the response boundary so the dashboard stream is unchanged.
- [ ] 3.2 Rebuild D-MG9 one-row-per-turn persistence WITHOUT `collectUIMessages` (removed in v7): store `UIMessage[]` as source of truth, `convertToModelMessages(...)` before the call, derive the persisted turn from `result.messages`. Preserve scratch/send classification + the recovered-send-as-`send_message` de-poison.
- [ ] 3.3 Apply the same swap to `workflows/job.ts` and `workflows/scheduledJob.ts`.
- [ ] 3.4 Migrate the model test seam (`src/agent/turnModel.ts`) off `@workflow/ai/test` `mockSequenceModel` to `ai`'s `MockLanguageModelV3`; fix the assistant-message-count history-indexing quirk (so deterministic turns no longer require a fresh thread).
- [ ] 3.5 Green the `@workflow/vitest` workflow suite (`tests/workflow/`) + the eval Local-World harness (`vitest.eval.config.ts`) on v7.

## 4. Telemetry re-host (D5)

- [ ] 4.1 Move OTel setup to `@ai-sdk/otel` `registerTelemetry(new OpenTelemetry(...))`; `experimental_telemetry`→`telemetry`. Re-attach `RedactingSpanProcessor` + `TracePromotingSpanProcessor` to the new pipeline.
- [ ] 4.2 Re-confirm `TracePromotingSpanProcessor` against v7's emitted span attributes (trace name/session/user/input/output still promote); fix attribute-name drift.

## 5. Langfuse trace cleanup (D4 — gated on evidence)

- [ ] 5.1 Drive a live turn post-migration and INSPECT the trace (`langfuse-cli`): count `send_message` / `ai.streamText` spans vs runtime sends/steps. Determine whether WorkflowAgent's heavier step-journaling already eliminates the replay re-emission.
- [ ] 5.2 If duplication persists: add an OTel `SpanProcessor`/`Sampler` that drops spans created within a `workflow.replay` context; verify one clean trace per turn. (And open an upstream `workflow` suppress-on-replay request.)
- [ ] 5.3 Confirm the `durable-execution` "one trace per turn, no replay duplication" requirement holds.

## 6. Client streaming — evaluate retiring the LiveBus chunk-bridge (D3)

- [ ] 6.1 Spike `WorkflowChatTransport` + durable `getReadable({ startIndex })` reconnect feeding the dashboard conversation pane directly (jobs already read the run stream).
- [ ] 6.2 If it cleanly subsumes the pane, retire the LiveBus chunk-bridging; KEEP the thread→active-run tracking app-side (the reason the LiveBus stayed in durable-main-loop). Otherwise leave the bridge and record why.

## 7. Verify behavioral parity (D2 unknowns)

- [ ] 7.1 Reasoning/thinking: live Anthropic check that `convertToModelMessages` does NOT re-send thinking blocks; keep/adjust the reasoning strip accordingly.
- [ ] 7.2 Steering: confirm `loadSteers` (store-read in `prepareStep`) still folds mid-turn messages on WorkflowAgent; only replace with a v7 primitive if one is proven safe (no FIFO parking hazard).
- [ ] 7.3 Confirm exactly-once delivery on replay (the workflow exactly-once test) + per-thread serialization + the `processedAt` watermark all still hold.

## 8. Cutover

- [ ] 8.1 Full verification: typecheck + all deterministic lanes + one eval dimension + loopback live smoke (default-durable, deterministic + real model); Langfuse trace named/grouped/clean.
- [ ] 8.2 Deploy + soak; rollback = revert the change (back to `DurableAgent`). Update AGENTS.md/README/memory for the v7 stack; PR + archive.
