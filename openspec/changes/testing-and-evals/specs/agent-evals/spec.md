## ADDED Requirements

### Requirement: Behavioral eval harness
Sunny SHALL provide an eval harness that runs the real agent loop against the fake gateway with a configurable model (defaulting to the production model), feeding scripted inbound messages and capturing the full turn outcome (messages, tool calls, results, telemetry) for grading.

#### Scenario: Eval case runs end-to-end against the real loop
- **WHEN** an eval case is executed
- **THEN** the harness runs the actual agent loop and tool dispatch for that case
- **AND** it captures the turn's messages, tool calls, results, and telemetry for grading

#### Scenario: Model is configurable
- **WHEN** an eval run is configured with a specific model
- **THEN** the harness uses that model for the agent loop
- **AND** defaults to the production model when none is specified

### Requirement: Versioned scenario dataset
Eval cases SHALL be defined as versioned, human-readable files checked into the repository. Each case SHALL declare its setup (seeded memory/conversation/config), its input message(s), and the graders that judge it.

#### Scenario: Case declares setup, input, and graders
- **WHEN** an eval case file is loaded
- **THEN** the harness applies its declared setup, sends its input message(s), and runs its declared graders
- **AND** the case is version-controlled so changes are reviewable

### Requirement: Programmatic graders
The eval harness SHALL support deterministic, programmatic graders that assert on observable facts of a turn — which tools were called and with what arguments, how many user-facing messages were sent, and whether a gated action was taken.

#### Scenario: Assertion on tool usage
- **WHEN** a programmatic grader checks that exactly one `send_message` occurred
- **THEN** the case passes only if the captured turn made exactly one `send_message` call

### Requirement: LLM-as-judge graders
The eval harness SHALL support rubric-based LLM-as-judge graders for qualities that are not deterministically checkable (helpfulness, tone, appropriate use of recalled memory). The judge model and rubric SHALL be versioned, and SHALL be distinct from the model under evaluation.

#### Scenario: Rubric judge scores a transcript
- **WHEN** a judge grader evaluates a captured transcript against its rubric
- **THEN** it returns a score/verdict used in the case result
- **AND** the judge model and rubric used are recorded with the result

### Requirement: Core eval dimensions
The scenario dataset SHALL cover, at minimum, these behavioral dimensions: **`send_message` elicitation** (the model communicates only via the tool, never leaking private scratch as the user-facing reply), **memory recall** (seeded facts are retrieved and used, including recording a durable fact via `memory_write` and recalling older history), and **tool selection** (the appropriate tool is chosen for a request — e.g. a durable job vs an inline reply, scheduling vs immediate action, and not over-calling tools for a trivial message). Security-gating evaluation is deferred — the current focus is owner DMs — and returns alongside the Phase-4 `security-tools-credentials` work.

#### Scenario: send_message elicitation is evaluated
- **WHEN** the elicitation dimension is evaluated over its cases
- **THEN** each case checks that the user-facing reply was delivered via `send_message`
- **AND** flags any turn that fell back to delivering private scratch text

#### Scenario: Tool selection is evaluated
- **WHEN** a tool-selection case presents a request that warrants a specific tool
- **THEN** the grader confirms the expected tool was (or was not) called for that request

### Requirement: Pass-rate scoring with thresholds
Because model output is non-deterministic, the harness SHALL run each case multiple times (configurable N) and score by pass rate, comparing against a configured threshold per case or dimension rather than requiring single-shot exact equality.

#### Scenario: Flaky case judged by pass rate
- **WHEN** a case is run N times and passes on a fraction of runs
- **THEN** the case is scored by that pass rate against its configured threshold
- **AND** it is reported as passing only if the threshold is met

### Requirement: Scorecard and regression tracking
Each eval run SHALL produce a persisted scorecard (per-case and per-dimension pass rates, model, timestamp, cost) so results can be compared across runs to detect regressions.

#### Scenario: Run produces a comparable scorecard
- **WHEN** an eval run completes
- **THEN** a scorecard with per-dimension pass rates, model, and cost is persisted
- **AND** it can be compared against a prior run to surface regressions

### Requirement: Evals are cost-controlled and off the per-commit path
Evals SHALL be invoked on demand or on a schedule, never as part of the per-commit CI gate, and SHALL be bounded by a cost cap. An eval run that would exceed its budget SHALL stop and report rather than continue spending.

#### Scenario: Eval run respects its budget cap
- **WHEN** an eval run reaches its configured cost cap
- **THEN** the run stops and reports what completed rather than continuing to spend

#### Scenario: Results delivered over the gateway
- **WHEN** a scheduled eval run finishes
- **THEN** its scorecard summary can be delivered to the owner over the messaging gateway
