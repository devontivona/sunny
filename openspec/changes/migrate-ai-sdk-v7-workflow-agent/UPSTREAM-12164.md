# Draft upstream report — vercel/ai #12164 ("Make AI SDK work in Workflow")

> Post as a comment on #12164 (or a new linked issue). Trim to taste before filing.

**Title:** `WorkflowAgent` + Workflow DevKit: `registerTelemetry(new OpenTelemetry())` produces zero spans (telemetry integration is realm-local; agent loop runs in the DevKit `node:vm`)

**Summary**

With `@ai-sdk/workflow` `WorkflowAgent` running on the Workflow DevKit (`workflow` + `@workflow/world-postgres`), durable agent turns emit **no** OpenTelemetry spans, even though the documented setup (`registerTelemetry(new OpenTelemetry())` from `@ai-sdk/otel` at app startup) is in place and works for non-durable `generateText`/`streamText` in the same process. There is currently no documented OTel/Langfuse path for `WorkflowAgent`; the only telemetry example (`examples/next-workflow/workflow/telemetry-agent.ts`) uses a custom per-call `Telemetry` integration that forwards events out via `'use step'`/`workflow.fetch`.

**Versions:** `ai@7.0.4`, `@ai-sdk/workflow@1.0.4`, `@ai-sdk/otel@1.0.4`, `@ai-sdk/anthropic@4.0.1`, `workflow@4.5.0`, `@workflow/world-postgres@4.2.0`, Node 24.

**Root cause (verified in source + empirically)**

1. The DevKit runs the `'use workflow'` orchestration in an isolated `node:vm` context with its own `globalThis` (`@workflow/core/dist/workflow.js` → `createContext()` + `runInContext(workflowCode, …)`; it bridges only `console` + a request-context symbol into the VM).
2. `WorkflowAgent`'s telemetry is dispatched from the agent loop (`stream-text-iterator.ts`) **inside that VM** via `createRestrictedTelemetryDispatcher`, which resolves integrations from the VM realm's registry (per-call `telemetry.integrations` or the global registry).
3. `registerTelemetry(...)` writes to the **main process** realm's registry; the VM realm never sees it. And `@ai-sdk/otel`'s `OpenTelemetry` resolves its tracer via `@opentelemetry/api`'s `trace.getTracer('ai')`, which is a no-op in the VM realm (no provider registered there). So spans are silently non-recording.
4. We confirmed empirically (in-memory exporter, Local World which uses the same `node:vm`): a real durable turn produced **0 AI-SDK spans** with global `registerTelemetry`. Even per-call `telemetry: { integrations: [new OpenTelemetry()] }` produced 0 (the integration creates spans synchronously via the no-op VM tracer). A custom integration that forwards lifecycle events out of the VM via a journaled `'use step'` and creates spans in the main realm **does** work and captures the full hierarchy.

Note: registering in the step realm doesn't help either — `doStreamStep`/`streamLanguageModelCall` only telemeters via passed-in callbacks (default no-ops) and never consults the global registry; all dispatch is from the VM-side agent loop.

**Ask**

A realm-bridging OTel integration for `WorkflowAgent` (or at minimum docs): either (a) a first-class `@ai-sdk/otel` integration that survives the DevKit VM boundary, or (b) documented guidance that OTel/Langfuse on `WorkflowAgent` requires a custom event-forwarding `Telemetry` integration (like the DevTools example), with a reusable helper. Relatedly, the `TODO(#12164)` to replace the telemetry-bridge `any` casts with typed Workflow telemetry events, and `@ai-sdk/otel` reading `performance`/`finalStep` on end events that `WorkflowAgent` doesn't fully populate (had to be defensively defaulted to avoid throws).

**Repro:** `WorkflowAgent` on the DevKit + `registerTelemetry(new OpenTelemetry())` at startup → drive a turn → no spans exported. (Minimal repro available on request.)
