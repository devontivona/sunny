## ADDED Requirements

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
