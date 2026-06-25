## Why

Sunny acts autonomously (scheduled runs, durable jobs, tool use) and spends real money on Opus. Today there are only structured logs. To trust autonomy, Devon needs to see what Sunny did and why (traces/trajectories) — and to do it *sooner rather than later*. This change delivers that **visibility** foundation: self-hosted tracing, durable trajectories, and a redaction gate, so traces are explorable now. Bounding spend (budget meter + kill switch), the redacted audit trail, and insights summaries follow in the **`observability-2`** change.

## What Changes

Add the **observability** capability (originally Phase 6 of `bootstrap-sunny`), built on **self-hosted Langfuse** as the telemetry platform — scoped here to the visibility foundation: stand up Langfuse (no egress); a redaction-at-source gate; OpenTelemetry spans (AI SDK + WDK + gateway/tool) exported over OTLP to Langfuse; and per-run trajectories captured as Langfuse traces (no separate trajectory store). Budget metering + enforcement, the redacted audit log, and insights move to **`observability-2`**. Backups are deferred out of MVP scope.

## Capabilities

### New Capabilities
- **observability** — self-hosted **Langfuse** as the OTel backend + trace/trajectory store; OpenTelemetry spans for LLM/tool/step/job activity; per-run trajectories as Langfuse traces; redaction at every telemetry sink. (Budget enforcement, audit log, and insights are added by `observability-2`.)

## Impact

Builds on the bootstrapped foundation; needs no other in-flight change, so it can ship now. Its follow-up **`observability-2`** (budget enforcement, audit log, insights) depends on **security-tools-credentials** and picks up the per-run cost cap that `scheduling`'s "Bounded autonomous dispatch" requirement points to.
