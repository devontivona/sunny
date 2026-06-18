# durable-execution Specification

## Purpose
TBD - created by archiving change bootstrap-sunny. Update Purpose after archive.
## Requirements
### Requirement: Two-tier execution model
Sunny SHALL execute work in two tiers: Tier 1 in-process conversational turns for normal message handling, and Tier 2 durable background jobs for long or asynchronous tasks. The agent SHALL be able to promote work to Tier 2 (e.g. via a `start_job` action) when a task is long-running or asynchronous.

#### Scenario: Trivial turn stays in Tier 1
- **WHEN** an inbound message can be answered quickly
- **THEN** it is handled as an in-process Tier 1 turn without starting a durable workflow

#### Scenario: Long task is promoted to Tier 2
- **WHEN** the agent determines a task is long-running or asynchronous
- **THEN** it starts a durable Tier 2 job and the workflow runs to completion independently of the originating turn

### Requirement: Idempotent conversational turns survive restart
Each inbound message SHALL be persisted on arrival and processed idempotently, keyed by a stable message identifier. After a restart, Sunny SHALL re-process any received message that never produced a reply, and SHALL NOT act twice on the same message.

#### Scenario: Reboot before reply
- **WHEN** the process restarts after an inbound message was received but before a reply was sent
- **THEN** Sunny re-processes that message and sends a reply

#### Scenario: Duplicate inbound delivery
- **WHEN** the same inbound message is delivered more than once (e.g. a webhook retry)
- **THEN** Sunny processes it only once

### Requirement: Double-text steering of an in-flight run
When a new message from the owner arrives on a thread that already has an in-flight run, Sunny SHALL fold the new message into that run to steer it rather than killing the run and discarding its work. The new message SHALL take effect at the next step boundary of the in-flight run. Sunny MAY abort and restart only when the new message invalidates the current task.

#### Scenario: New message steers, not kills
- **WHEN** the owner sends a message while a run is still working on a prior message in the same thread
- **THEN** the new message is folded into the in-flight run at its next step
- **AND** the run's prior work is not discarded

#### Scenario: Task-invalidating message restarts
- **WHEN** the new message cancels or replaces the current task
- **THEN** Sunny may abort the in-flight run and start fresh with the new message

### Requirement: Durable background jobs survive crashes and resume
Tier 2 jobs SHALL be durable: a job that is interrupted by a crash, reboot, or timeout SHALL resume rather than restart from scratch, and SHALL notify the user through the messaging gateway on completion. Side-effecting operations within a job SHALL be expressed as retryable durable steps.

#### Scenario: Job survives a reboot
- **WHEN** the host reboots while a Tier 2 job is mid-execution
- **THEN** the job resumes from its last durable step after restart
- **AND** does not re-run already-completed side-effecting steps

#### Scenario: Completion notification
- **WHEN** a Tier 2 job finishes
- **THEN** Sunny sends the result to the user via the messaging gateway

### Requirement: Single-write message persistence
Messages SHALL be persisted to the conversation store exactly once, on completion of the turn or job, and SHALL NOT be written per replayed execution step. The agent SHALL run to completion before its messages are saved (no user-facing token streaming is required).

#### Scenario: Persist on completion
- **WHEN** a turn or job completes
- **THEN** its resulting messages are written to the conversation store one time

#### Scenario: Resume does not double-write
- **WHEN** a durable job resumes after interruption
- **THEN** replayed steps do not create duplicate persisted messages

### Requirement: Consolidated Postgres datastore
The message archive, full-text index, vector embeddings (when added), and durable-execution state SHALL be stored in a single Postgres instance. The memory soul (core files and topic documents) SHALL remain as markdown files outside the database.

#### Scenario: One database for DB-backed state
- **WHEN** Sunny stores messages, search indexes, embeddings, or workflow/job state
- **THEN** they reside in the same Postgres instance

#### Scenario: Memory soul stays in files
- **WHEN** Sunny stores or edits its core memory or topic documents
- **THEN** they remain markdown files on disk, not rows in the database

