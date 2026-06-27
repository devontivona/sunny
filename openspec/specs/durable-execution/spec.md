# durable-execution Specification

## Purpose
TBD - created by archiving change bootstrap-sunny. Update Purpose after archive.
## Requirements
### Requirement: Two-tier execution model
Sunny SHALL execute work in two tiers: Tier 1 conversational turns for normal message handling, and Tier 2 durable background jobs for long or asynchronous tasks. Tier-1 turns SHALL run as durable workflow runs (each turn a per-thread run, serialized so a thread processes one turn at a time), so that a conversational turn is observable and resumable on the same durable runtime as Tier-2 jobs. The agent SHALL be able to promote work to Tier 2 (e.g. via a `start_job` action) when a task is long-running or asynchronous; promotion remains a distinct, fully independent run.

#### Scenario: Normal turn runs as a durable per-thread run
- **WHEN** an inbound message arrives on a thread
- **THEN** it is handled by a durable conversational run for that thread, which processes the turn and completes; the next message starts the next turn
- **AND** the run is visible in the workflow runs inspector

#### Scenario: Long task is promoted to Tier 2
- **WHEN** the agent determines a task is long-running or asynchronous
- **THEN** it starts a durable Tier 2 job and the workflow runs to completion independently of the originating conversational run

### Requirement: Idempotent conversational turns survive restart
Each inbound message SHALL be persisted on arrival and processed idempotently, keyed by a stable message identifier. A conversational turn SHALL execute as durable steps so that, after a crash or restart mid-turn, it resumes from its last completed durable step rather than restarting, and side-effecting steps already completed (e.g. a delivered message) SHALL NOT run twice. Sunny SHALL NOT act twice on the same inbound message.

#### Scenario: Reboot mid-turn resumes from last step
- **WHEN** the process restarts after a conversational turn has completed some durable steps but before the turn finished
- **THEN** the turn resumes from its last completed durable step
- **AND** a message already delivered in a completed step is not sent again

#### Scenario: Reboot before any reply
- **WHEN** the process restarts after an inbound message was received but before its turn produced a reply
- **THEN** Sunny processes that message and sends a reply exactly once

#### Scenario: Duplicate inbound delivery
- **WHEN** the same inbound message is delivered more than once (e.g. a webhook retry)
- **THEN** Sunny processes it only once

### Requirement: Double-text steering of an in-flight run
When a new message from the owner arrives on a thread that already has an in-flight conversational run, Sunny SHALL fold the new message into that run to steer it rather than killing the run and discarding its work. The new message SHALL take effect at the next step boundary of the in-flight run, where the run reads any newly-arrived messages before its next model call. Sunny MAY abort and restart only when the new message invalidates the current task.

#### Scenario: New message steers, not kills
- **WHEN** the owner sends a message while a run is still working on a prior message in the same thread
- **THEN** the new message is folded into the in-flight run at its next step
- **AND** the run's prior work is not discarded

#### Scenario: Steer arriving with no pending step
- **WHEN** a steer message arrives after the run finished its work for the prior message
- **THEN** it is processed as the next turn on the same thread without starting a competing run

#### Scenario: Task-invalidating message restarts
- **WHEN** the new message cancels or replaces the current task
- **THEN** Sunny may abort the in-flight run and start fresh with the new message

### Requirement: Conversational turns are observable on the durable runtime
Tier-1 conversational turns SHALL emit their execution to the durable workflow runtime such that each turn appears in the workflow runs inspector with its per-step trace, in addition to existing trajectory telemetry. Existing telemetry grouping (one session per thread) SHALL be preserved.

#### Scenario: Turn appears in the runs inspector
- **WHEN** a conversational turn executes
- **THEN** its run and per-step trace are visible via the workflow runs inspector
- **AND** the turn's existing per-thread telemetry session grouping is unchanged

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

