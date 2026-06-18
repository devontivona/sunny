## ADDED Requirements

### Requirement: OpenTelemetry tracing, self-hosted
Sunny SHALL emit OpenTelemetry spans for LLM calls, tool invocations, execution steps, gateway events, and durable jobs, and SHALL export them to a self-hosted collector/backend. Telemetry SHALL NOT be sent to a third-party service by default; any cloud export SHALL be explicit opt-in.

#### Scenario: Spans emitted and kept local
- **WHEN** Sunny handles a turn or runs a job
- **THEN** it emits OpenTelemetry spans for the LLM/tool/step activity
- **AND** they are exported only to the self-hosted backend unless cloud export is explicitly enabled

### Requirement: Per-run trajectory records
Sunny SHALL persist a structured trajectory for each turn and job, capturing messages, tool calls and their results, and key decisions, for later inspection.

#### Scenario: Trajectory captured
- **WHEN** a turn or job completes
- **THEN** a structured trajectory record for it is persisted and can be inspected later

### Requirement: Cost/token budget metering with enforcement
Sunny SHALL meter token usage and cost per run and over rolling windows, and SHALL enforce configured caps (including the per-run cost cap and autonomous rate limit used by scheduling). A run that exceeds its cap SHALL be stopped and the user notified rather than continuing to spend.

#### Scenario: Per-run cap enforced
- **WHEN** a run's metered cost reaches its configured cap
- **THEN** the run is stopped and the user is notified

#### Scenario: Usage is queryable
- **WHEN** the user asks about cost or token usage
- **THEN** Sunny can report metered usage for the relevant period

### Requirement: Global spend circuit-breaker
There SHALL be a global daily/monthly spend ceiling covering all activity (interactive and scheduled), and an agent-loop step cap. When the global ceiling is reached, new agent work SHALL halt and the user SHALL be notified.

#### Scenario: Global ceiling halts work
- **WHEN** total spend reaches the configured global ceiling
- **THEN** new agent runs are halted and the user is notified

#### Scenario: Runaway loop is bounded
- **WHEN** an agent loop reaches its configured maximum number of steps
- **THEN** the loop stops rather than continuing unbounded

### Requirement: Redacted audit log
Sunny SHALL record every tool invocation and secret access to a queryable audit log, with secret values redacted. This audit log SHALL NOT depend on any external plan or service.

#### Scenario: Tool/secret access audited
- **WHEN** a tool is invoked or a secret is accessed
- **THEN** an audit entry is written with secret values redacted

### Requirement: Secrets redacted from all telemetry sinks
Secret values and the credential token SHALL never appear in spans, logs, trajectories, audit entries, or insights output.

#### Scenario: No secret leakage in telemetry
- **WHEN** any telemetry, log, trajectory, audit entry, or insights summary is produced
- **THEN** it contains no secret values or the Service Account token

### Requirement: Insights summary
Sunny SHALL be able to produce a human-readable insights summary (token usage, cost, tool breakdown, activity) and deliver it over the messaging gateway on request or on a schedule.

#### Scenario: Insights on request
- **WHEN** the user asks for an activity/cost summary
- **THEN** Sunny produces an insights summary and delivers it over the gateway
