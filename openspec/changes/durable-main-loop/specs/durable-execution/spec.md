## MODIFIED Requirements

### Requirement: Two-tier execution model
Sunny SHALL execute work in two tiers: Tier 1 conversational turns for normal message handling, and Tier 2 durable background jobs for long or asynchronous tasks. Tier-1 turns SHALL run as durable workflow runs (one long-lived run per thread that processes one turn at a time), so that a conversational turn is observable and resumable on the same durable runtime as Tier-2 jobs. The agent SHALL be able to promote work to Tier 2 (e.g. via a `start_job` action) when a task is long-running or asynchronous; promotion remains a distinct, fully independent run.

#### Scenario: Normal turn runs as a durable per-thread run
- **WHEN** an inbound message arrives on a thread
- **THEN** it is handled by that thread's durable conversational run, which processes the turn and then suspends awaiting the next message
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
When a new message from the owner arrives on a thread that already has an in-flight conversational run, Sunny SHALL fold the new message into that run to steer it rather than killing the run and discarding its work. The new message SHALL be delivered to the in-flight run (e.g. by resuming a hook on the run) and take effect at the next step boundary, where the run injects any queued messages before its next model call. Sunny MAY abort and restart only when the new message invalidates the current task.

#### Scenario: New message steers, not kills
- **WHEN** the owner sends a message while a run is still working on a prior message in the same thread
- **THEN** the new message is routed to the in-flight run and folded in at its next step
- **AND** the run's prior work is not discarded

#### Scenario: Steer arriving with no pending step
- **WHEN** a steer message arrives after the run finished its work for the prior message
- **THEN** it is processed as the next turn on the same run without starting a competing run

#### Scenario: Task-invalidating message restarts
- **WHEN** the new message cancels or replaces the current task
- **THEN** Sunny may abort the in-flight run and start fresh with the new message

## ADDED Requirements

### Requirement: Conversational turns are observable on the durable runtime
Tier-1 conversational turns SHALL emit their execution to the durable workflow runtime such that each turn appears in the workflow runs inspector with its per-step trace, in addition to existing trajectory telemetry. Existing telemetry grouping (one session per thread) SHALL be preserved.

#### Scenario: Turn appears in the runs inspector
- **WHEN** a conversational turn executes
- **THEN** its run and per-step trace are visible via the workflow runs inspector
- **AND** the turn's existing per-thread telemetry session grouping is unchanged
