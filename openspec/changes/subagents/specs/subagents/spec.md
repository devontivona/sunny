## ADDED Requirements

### Requirement: Delegation with isolated context and result-only return
Sunny SHALL be able to delegate a subtask to a child agent that runs with its own isolated context, and only the child's final result SHALL return to the parent. The child's intermediate tool calls and outputs SHALL NOT enter the parent's context.

#### Scenario: Subtask isolated from parent context
- **WHEN** Sunny delegates a subtask to a child agent
- **THEN** the child runs in an isolated context
- **AND** only its final result is returned to the parent, not its intermediate work

### Requirement: Bounded concurrency and depth
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

### Requirement: Least-privilege subagents
A subagent's tools and credential references SHALL be a subset of its parent's, never broader. All subagent actions SHALL pass through the same tool-access gating, approval tiers, and blocklist as the parent.

#### Scenario: Subagent cannot exceed parent permissions
- **WHEN** a subagent attempts an action or credential resolution its parent could not perform
- **THEN** it is refused

#### Scenario: Untrusted-content subagent is powerless
- **WHEN** Sunny delegates processing of untrusted content
- **THEN** it can grant the subagent no credentials and no high-consequence tools

### Requirement: Subagent runs are durable and observed
A delegated task MAY run as a durable Tier-2 job, and subagent runs SHALL appear in observability as child spans/trajectories.

#### Scenario: Durable delegated task
- **WHEN** a long delegated task is run durably and the host restarts
- **THEN** the task resumes and reports its result via the gateway on completion

#### Scenario: Subagent work is inspectable
- **WHEN** a subagent runs
- **THEN** its activity is captured in observability as child spans/trajectories
