# observability Specification

## Purpose

TBD — created from the `observability` change. Defines Sunny's self-hosted telemetry:
OpenTelemetry spans exported over OTLP to a self-hosted Langfuse, a per-run trajectory
captured as Langfuse traces, and secret redaction across every telemetry sink.
## Requirements
### Requirement: OpenTelemetry tracing, self-hosted
Sunny SHALL emit OpenTelemetry spans for LLM calls, tool invocations, execution steps, gateway events, and durable jobs, and SHALL export them over OTLP to a self-hosted Langfuse instance. Telemetry SHALL NOT be sent to a third-party service by default; any cloud export SHALL be explicit opt-in.

#### Scenario: Spans emitted and kept local
- **WHEN** Sunny handles a turn or runs a job
- **THEN** it emits OpenTelemetry spans for the LLM/tool/step activity
- **AND** they are exported only to the self-hosted Langfuse backend unless cloud export is explicitly enabled

### Requirement: Per-run trajectory records
Sunny SHALL capture a structured trajectory for each turn and job — messages, tool calls and their results, and key decisions — as Langfuse traces, inspectable and replayable later. No separate trajectory store SHALL be maintained.

#### Scenario: Trajectory captured
- **WHEN** a turn or job completes
- **THEN** its structured trajectory is available as a Langfuse trace and can be inspected later

### Requirement: Secrets redacted from all telemetry sinks
Secret values and the credential token SHALL never appear in spans, Langfuse traces, logs, or any other telemetry sink. The redaction layer SHALL apply to sinks added later (e.g. the audit log and insights output specified in `observability-2`).

#### Scenario: No secret leakage in telemetry
- **WHEN** any telemetry, log, or trajectory is produced
- **THEN** it contains no secret values or the Service Account token

### Requirement: Live in-flight run event source
Sunny SHALL expose a read-only live event source that publishes step-level activity for **in-flight** turns and durable jobs as it happens — step boundaries, tool-call starts and their results/errors, in-progress assistant text, run status transitions (running / waiting-on-tool / finished / errored), and token-usage deltas (including cache read/write). Events SHALL be expressed in the same `UIMessage`/`UIMessageChunk` shape that Sunny already produces and persists, so the live and persisted records share one model. This live source SHALL be derived from the same activity already captured for trajectories; it SHALL NOT require a new persisted store for turns and SHALL NOT alter what trajectories record. Publishing live events SHALL NOT modify the byte-stable cached system prefix, and live events SHALL pass through the same secret-redaction layer as all other telemetry sinks.

#### Scenario: In-flight activity is published live
- **WHEN** a turn or job is running
- **THEN** its step boundaries, tool-call starts/results, in-progress assistant text, status transitions, and token deltas are published to subscribers of the live event source as they occur

#### Scenario: Live source does not change persistence or the cached prefix
- **WHEN** live events are published for a run
- **THEN** no separate trajectory store is introduced and the persisted trajectory is unchanged
- **AND** the always-on cached system prefix is not modified by the publish path

#### Scenario: Live events share the persisted message shape
- **WHEN** a turn or job's live activity is published and the same turn/job is later read from its persisted record
- **THEN** both express the activity as the same `UIMessage`/part shape, with no second event schema to reconcile

#### Scenario: Live events are redacted
- **WHEN** any live run event is published
- **THEN** it contains no secret values and no Service Account token

