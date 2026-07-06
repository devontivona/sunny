# durable-execution Specification

## Purpose
TBD - created by archiving change bootstrap-sunny. Update Purpose after archive.
## Requirements
### Requirement: Two-tier execution model
Sunny SHALL execute work in two tiers: Tier 1 conversational turns for normal message handling, and Tier 2 durable runs for long or asynchronous tasks. Tier-1 turns SHALL run as durable workflow runs (each turn a per-thread run, serialized so a thread processes one turn at a time), so that a conversational turn is observable and resumable on the same durable runtime as Tier-2 runs. Work promoted FROM A CONVERSATION SHALL run as a delegated subagent (see *Non-blocking delegation with isolated context and result-only return*): its result returns to the conversation thread as an attributed report, and a normal conversational turn mediates it into the user-facing reply — conversation-promoted work SHALL NOT deliver directly to the user. Direct terminal delivery to a user thread is reserved for scheduled runs, which have no live conversation to mediate them.

#### Scenario: Normal turn runs as a durable per-thread run
- **WHEN** an inbound message arrives on a thread
- **THEN** it is handled by a durable conversational run for that thread, which processes the turn and completes; the next message starts the next turn
- **AND** the run is visible in the workflow runs inspector

#### Scenario: Long task promoted from a conversation is delegated
- **WHEN** the agent determines a conversational task is long-running or asynchronous
- **THEN** it delegates the task to an isolated child run and its own reply just acknowledges the promotion
- **AND** the child's report returns to the conversation thread, where a normal turn summarizes it for the user in the product's voice

#### Scenario: A raw background report never reaches the user unmediated
- **WHEN** conversation-promoted background work completes with a long or unformatted result
- **THEN** the user receives a mediating turn's summary of it, not the raw result text

#### Scenario: Scheduled runs still deliver terminally
- **WHEN** a scheduled run fires and completes with a result
- **THEN** its result is delivered to its configured target directly (there is no live conversation to mediate it)

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
Tier-1 conversational turns SHALL emit their execution to the durable workflow runtime such that each turn appears in the workflow runs inspector with its per-step trace. Existing per-thread telemetry session grouping (one session per thread) SHALL be preserved for the telemetry that IS emitted (the main-realm paths — e.g. the turn backstop and progress translator).

External AI-SDK trajectory telemetry (OpenTelemetry → Langfuse) for the DURABLE path is NOT emitted in this version, and SHALL be **explicitly disabled** (`telemetry.isEnabled: false` on the durable `WorkflowAgent` calls) rather than silently producing no spans. This is a known AI SDK v7 + Workflow DevKit limitation: the WDK runs the agent loop in an isolated `node:vm` realm that the global `registerTelemetry` integration cannot reach, so any apparently-enabled telemetry would emit nothing. The prior "single clean trace per turn, no replay duplication" guarantee is therefore DEFERRED pending upstream support (vercel/ai#12164) or adoption of the event-forwarding bridge (implemented + proven, kept on a shelf branch). Re-enabling is a localized change (restore the per-call telemetry integration); the rest of the durable runtime is unaffected.

#### Scenario: Turn appears in the runs inspector
- **WHEN** a conversational turn executes
- **THEN** its run and per-step trace are visible via the workflow runs inspector
- **AND** the turn's existing per-thread telemetry session grouping is unchanged for any telemetry it emits

#### Scenario: Durable external telemetry is explicitly disabled, not silently failing
- **WHEN** a conversational turn runs the durable `WorkflowAgent`
- **THEN** external AI-SDK OpenTelemetry/Langfuse spans are not emitted for the durable path
- **AND** this is configured explicitly (`telemetry.isEnabled: false` with an in-code rationale), so the absence is intentional and documented rather than an apparent-but-broken integration

### Requirement: Durable background jobs survive crashes and resume
Tier 2 jobs SHALL be durable: a job that is interrupted by a crash, reboot, or timeout SHALL resume rather than restart from scratch. On completion a job SHALL deliver its result through the **delivery bus**, resolved from its **Audience** (see *Configurable output target*), rather than always notifying the user; a job with no messaging grant delivers nothing and records its result. Side-effecting operations within a job SHALL be expressed as retryable durable steps.

#### Scenario: Job survives a reboot
- **WHEN** the host reboots while a Tier 2 job is mid-execution
- **THEN** the job resumes from its last durable step after restart
- **AND** does not re-run already-completed side-effecting steps

#### Scenario: Completion delivered to the job's audience
- **WHEN** a Tier 2 job finishes with a result
- **THEN** its result is delivered through the bus to the job's audience (a bound thread via the gateway, or a parent run's inbox), or nothing is sent if the job holds no messaging grant

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

### Requirement: Configurable output target
Every durable run SHALL be addressed by an **Audience** (the run-audiences capability) — `person`, `household`, `thread`, or `parent` — rather than a fixed `user`/`parent`/`silent` output target. Delivery SHALL go through the single delivery bus, which resolves the Audience to a Thread and dispatches on its binding (bound → gateway, detached → append + wake). A run not endowed a messaging grant SHALL send no proactive message and SHALL still record its result (silence is structural, not an output mode). A run's terminal message SHALL be delivered through the same bus — not a separate per-profile terminal-emit path — so headless output is never stranded. A `parent`-audience run's messages SHALL be delivered to its spawning run.

#### Scenario: Silent maintenance job sends nothing
- **WHEN** a run with no messaging grant (e.g. nightly memory consolidation) completes
- **THEN** no proactive message is sent, and its result is still recorded for later inspection

#### Scenario: Delegated child reports to its parent
- **WHEN** a run with a `parent` audience delivers a message
- **THEN** it is delivered to its spawning run through the bus, not to a human

#### Scenario: Run reports to its audience, not always the owner
- **WHEN** a run with a `person` audience delivers its result
- **THEN** it goes to that person's conversation via the bus, even if that person is not the owner

### Requirement: Configurable model per run
A delegated or background durable run SHALL be able to specify the model it runs on, independently of the main thread's model.

#### Scenario: Child runs on a smaller model
- **WHEN** Sunny delegates a bounded subtask and specifies a smaller model
- **THEN** the child run executes on that model while Sunny continues on its own

### Requirement: Non-blocking delegation with isolated context and result-only return
Sunny SHALL be able to delegate a subtask by starting a child durable run that executes in its own isolated context, and the delegation call SHALL return a handle immediately without blocking the parent. The child's intermediate tool calls and outputs SHALL NOT enter the parent's context; only what the child deliberately reports SHALL reach the parent. The child's report SHALL be its assistant TEXT — its final text delivered terminally, plus any explicit mid-task report blocks (see *Bidirectional asynchronous parent-child messaging*) — not messages emitted via a messaging tool; the child toolset SHALL NOT include a messaging tool.

#### Scenario: Delegation does not block the parent
- **WHEN** Sunny delegates a subtask
- **THEN** it receives a handle to the child run immediately
- **AND** the parent run continues or suspends without waiting inline for the child

#### Scenario: Child intermediate work stays out of the parent context
- **WHEN** a child run performs tool calls and produces large intermediate output
- **THEN** that intermediate work does not enter the parent's context
- **AND** only what the child deliberately reports — its final text and any explicit report blocks — reaches the parent

#### Scenario: Final text is the terminal report
- **WHEN** a child run completes with final assistant text
- **THEN** that text is delivered to the parent as the child's report, attributed to the child's label
- **AND** no messaging tool call is required for the report to be delivered

### Requirement: Least-privilege child runs
Every **spawned** run — a delegated child, a background job, or a scheduled run — SHALL be endowed an authority (tools + credential references) that is a subset of its creator's, never broader, granted explicitly at spawn with no ambient inheritance. All spawned-run actions SHALL pass through the same tool-access gating, approval tiers, and blocklist as the creator. A spawned run SHALL NOT resolve a credential reference its creator could not, nor invoke a tool it was not endowed even if that tool exists in-process.

#### Scenario: Spawned run cannot exceed creator permissions
- **WHEN** a spawned run attempts an action or credential resolution its creator could not perform
- **THEN** it is refused

#### Scenario: Untrusted-content child is powerless
- **WHEN** Sunny delegates processing of untrusted content
- **THEN** it can grant the child no credentials and no high-consequence tools

#### Scenario: Endowment is explicit, not ambient
- **WHEN** a spawned run was not endowed a given tool grant
- **THEN** it cannot invoke that tool even though the tool is registered in the process

### Requirement: Bidirectional asynchronous parent-child messaging
A parent run SHALL be able to send a message to a still-running child, and a child run SHALL be able to proactively report (progress or result) to its parent — both delivered to the recipient, folded into its in-flight run at the next step boundary if it is running, otherwise picked up by the next run started for the recipient, using the same mechanism as owner double-text steering, without the recipient polling. Child→parent reporting SHALL be text-based: the child's final text SHALL be delivered terminally as its result, and a mid-task progress report SHALL be expressed as an explicit sentinel-delimited report block (`<report>…</report>`) in the child's interim text, extracted at a step boundary and delivered while the child continues working. A child SHALL signal "nothing to report" by making a no-report sentinel its entire final text, in which case nothing is delivered to the parent and the run still completes normally. A final text containing real content alongside a stray sentinel SHALL be delivered with the sentinel stripped — content genuinely written for the parent SHALL never be swallowed. If a child ends with neither final text nor the sentinel, the system SHALL fall back to delivering its raw interim narration (or a fixed empty-result notice when there is none), without invoking an additional model.

#### Scenario: Child reports without the parent polling
- **WHEN** a child has a result to report
- **THEN** its final text is delivered to the parent
- **AND** the parent processes it at its next step boundary if running, or a fresh parent run is started to handle it if idle, without the parent having polled

#### Scenario: Mid-task report block is delivered while the child keeps working
- **WHEN** a still-running child writes a `<report>…</report>` block in its interim text
- **THEN** the block's content is delivered to the parent at the child's next step boundary
- **AND** the child continues its task
- **AND** an already-delivered block is not delivered again by the terminal report or on replay

#### Scenario: Child signals nothing to report
- **WHEN** a child's entire final text is the no-report sentinel
- **THEN** nothing is delivered to the parent
- **AND** the child's link still closes as completed

#### Scenario: Empty final without sentinel falls back to raw narration
- **WHEN** a child ends with no final text and no sentinel
- **THEN** its raw interim narration (or a fixed empty-result notice) is delivered to the parent
- **AND** no additional model call is made to compose the report

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
Child runs SHALL appear in the workflow runs inspector as runs/steps associated with their parent, so delegated work is as inspectable as the parent's. External trajectory telemetry (OpenTelemetry → Langfuse) is currently NOT emitted for durable runs (a known AI SDK v7 limitation — see the `durable-execution` "Conversational turns are observable on the durable runtime" requirement); when durable telemetry is re-enabled, child spans SHALL associate with their parent run.

#### Scenario: Delegated work is inspectable
- **WHEN** a child run executes
- **THEN** its run and per-step trace are visible in the workflow runs inspector and associated with the parent run

#### Scenario: External trajectory telemetry follows the durable-path posture
- **WHEN** a child run executes while durable external telemetry is disabled (the current v7 posture)
- **THEN** no external OTel/Langfuse spans are emitted for the child (consistent with the parent); observability is via the runs inspector

