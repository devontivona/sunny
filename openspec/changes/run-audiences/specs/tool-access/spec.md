## ADDED Requirements

### Requirement: Spawn tools share an audience + authority argument shape
The run-creation tools (`start_job`, `delegate_task`, `schedule_create`) SHALL remain distinct verbs (for reliable model tool-selection) but SHALL accept a common `{ audience, authority }` argument shape, where `authority` is the subset of the creating run's grants to endow (subsuming `delegate_task`'s prior `toolset` argument). A spawn call SHALL be refused if the requested `authority` is not a subset of the creating run's authority.

#### Scenario: Shared shape across spawn verbs
- **WHEN** Sunny starts a background job, delegates a subtask, or creates a schedule
- **THEN** each accepts the same `audience` and `authority` arguments, differing only in when it fires

#### Scenario: Over-broad authority request refused
- **WHEN** a spawn requests an authority grant the creating run does not itself hold
- **THEN** the spawn is refused

### Requirement: Unified run inspection and cancellation
Sunny SHALL expose audience-agnostic `list_runs` and `cancel_run` tools that span schedules, background jobs, and delegated subagents, scoped by ownership: a caller SHALL see and cancel runs whose principal is themselves, and the owner SHALL see and cancel all runs. These SHALL replace schedule-specific list/delete as the general lifecycle surface.

#### Scenario: List spans all spawned run kinds
- **WHEN** Sunny lists runs on behalf of a principal
- **THEN** the result includes that principal's schedules, background jobs, and subagents

#### Scenario: Non-owner cannot cancel another principal's run
- **WHEN** a family member attempts to cancel a run whose principal is someone else
- **THEN** it is refused, while the owner may cancel any run
