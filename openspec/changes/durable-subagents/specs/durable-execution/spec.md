## MODIFIED Requirements

### Requirement: Durable background jobs survive crashes and resume
Tier 2 jobs SHALL be durable: a job that is interrupted by a crash, reboot, or timeout SHALL resume rather than restart from scratch. On completion a job SHALL report to its **configured output target** (see *Configurable output target*) rather than always notifying the user. Side-effecting operations within a job SHALL be expressed as retryable durable steps.

#### Scenario: Job survives a reboot
- **WHEN** the host reboots while a Tier 2 job is mid-execution
- **THEN** the job resumes from its last durable step after restart
- **AND** does not re-run already-completed side-effecting steps

#### Scenario: Completion reported to the configured target
- **WHEN** a Tier 2 job finishes
- **THEN** its result is reported to the job's configured output target (the user via the gateway, the spawning parent run, or no proactive message when silent)

## ADDED Requirements

### Requirement: Configurable output target
Every durable run SHALL have an output target of `user`, `parent`, or `silent`. A `user` run's messages SHALL be delivered to the owner through the messaging gateway. A `parent` run's messages SHALL be delivered to its spawning run. A `silent` run SHALL send no proactive messages; it SHALL complete and record its result without messaging anyone.

#### Scenario: Silent maintenance job sends nothing
- **WHEN** a run configured `silent` (e.g. nightly memory consolidation) completes
- **THEN** no proactive message is sent to the user
- **AND** its result is still recorded for later inspection

#### Scenario: Delegated child reports to its parent
- **WHEN** a run configured `parent` sends a message
- **THEN** the message is delivered to its spawning run, not to the user

#### Scenario: User-targeted job reports to the owner
- **WHEN** a run configured `user` completes with a result
- **THEN** the result is delivered to the owner via the messaging gateway

### Requirement: Configurable model per run
A delegated or background durable run SHALL be able to specify the model it runs on, independently of the main thread's model.

#### Scenario: Child runs on a smaller model
- **WHEN** Sunny delegates a bounded subtask and specifies a smaller model
- **THEN** the child run executes on that model while Sunny continues on its own

### Requirement: Non-blocking delegation with isolated context and result-only return
Sunny SHALL be able to delegate a subtask by starting a child durable run that executes in its own isolated context, and the delegation call SHALL return a handle immediately without blocking the parent. The child's intermediate tool calls and outputs SHALL NOT enter the parent's context; only messages the child sends to the parent SHALL reach it.

#### Scenario: Delegation does not block the parent
- **WHEN** Sunny delegates a subtask
- **THEN** it receives a handle to the child run immediately
- **AND** the parent run continues or suspends without waiting inline for the child

#### Scenario: Child intermediate work stays out of the parent context
- **WHEN** a child run performs tool calls and produces large intermediate output
- **THEN** that intermediate work does not enter the parent's context
- **AND** only what the child deliberately reports reaches the parent

### Requirement: Least-privilege child runs
A child run's tools and credential references SHALL be a subset of its parent's, never broader. All child actions SHALL pass through the same tool-access gating, approval tiers, and blocklist as the parent. A child SHALL NOT resolve a credential reference its parent could not.

#### Scenario: Child cannot exceed parent permissions
- **WHEN** a child run attempts an action or credential resolution its parent could not perform
- **THEN** it is refused

#### Scenario: Untrusted-content child is powerless
- **WHEN** Sunny delegates processing of untrusted content
- **THEN** it can grant the child no credentials and no high-consequence tools

### Requirement: Bidirectional asynchronous parent-child messaging
A parent run SHALL be able to send a message to a still-running child, and a child run SHALL be able to proactively send messages (progress or result) to its parent. Messages in both directions SHALL be delivered to the in-flight recipient run and folded in at its next step boundary, using the same mechanism as owner double-text steering, without the recipient polling.

#### Scenario: Child reports without the parent polling
- **WHEN** a child has progress or a result to report
- **THEN** it sends a message that is delivered to the parent run
- **AND** the parent processes it at its next step boundary or wakes from idle to handle it, without having polled

#### Scenario: Parent steers a running child
- **WHEN** the parent sends a message to a child that is still working
- **THEN** the message is delivered to the child run and folded in at its next step boundary
- **AND** the child's prior work is not discarded

### Requirement: Terminal child failure is reported to the parent
When a child run fails terminally or exceeds its configured budget, the runtime SHALL emit a failure or timeout event to the parent run, since a failed child cannot report for itself.

#### Scenario: Dead child surfaces to the parent
- **WHEN** a child run crashes terminally or exceeds its time/token budget
- **THEN** the runtime delivers a failure/timeout event to the parent run
- **AND** the parent can decide whether to retry, drop it, or inform the owner

### Requirement: Bounded fan-out and depth
Delegation SHALL be bounded by a maximum number of concurrent children and a maximum spawn depth. A child SHALL NOT delegate further unless explicitly designated an orchestrator.

#### Scenario: Concurrency cap
- **WHEN** delegations would exceed the configured concurrency limit
- **THEN** the excess waits rather than running immediately

#### Scenario: Depth cap
- **WHEN** delegation would exceed the configured maximum depth
- **THEN** the further delegation is not allowed

#### Scenario: Non-orchestrator child cannot delegate
- **WHEN** a child that is not an orchestrator attempts to delegate
- **THEN** the delegation is refused

### Requirement: Child runs are observable
Child runs SHALL appear in the workflow runs inspector and in trajectory telemetry as runs/spans associated with their parent, so delegated work is as inspectable as the parent's.

#### Scenario: Delegated work is inspectable
- **WHEN** a child run executes
- **THEN** its run and per-step trace are visible in the inspector and associated with the parent run
