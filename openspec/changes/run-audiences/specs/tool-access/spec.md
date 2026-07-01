## ADDED Requirements

### Requirement: Spawn tools share an audience + authority argument shape
The run-creation tools (`start_job`, `delegate_task`, `schedule_create`) SHALL remain distinct verbs (for reliable model tool-selection) but SHALL accept a common `{ audience, authority }` argument shape, where `authority` is the subset of the creating run's grants to endow (subsuming `delegate_task`'s prior `toolset` argument). A spawn call SHALL be refused if the requested `authority` is not a subset of the creating run's authority.

#### Scenario: Shared shape across spawn verbs
- **WHEN** Sunny starts a background job, delegates a subtask, or creates a schedule
- **THEN** each accepts the same `audience` and `authority` arguments, differing only in when it fires

#### Scenario: Over-broad authority request refused
- **WHEN** a spawn requests an authority grant the creating run does not itself hold
- **THEN** the spawn is refused

### Requirement: Messaging tools — one reply verb, one addressed verb, over the bus
Outward messaging SHALL be exposed as two tools, both delivering through the single delivery bus: `send_message(text)` SHALL reply to the run's own Audience (no address argument), and one addressed `message(recipient, text)` SHALL send to a named other entity whose `recipient` resolves against {roster people} ∪ {the run's currently-running subagents}. This addressed tool SHALL subsume the former `message_person` (relay to a roster member) and `message_subagent` (steer a running child) — they are the same bus operation to a different mailbox. Arbitrary (non-roster, non-subagent) recipients SHALL be refused.

#### Scenario: Reply needs no address
- **WHEN** Sunny replies to whoever it is currently serving
- **THEN** it calls `send_message(text)` with no recipient, and delivery resolves from the run's Audience

#### Scenario: One addressed verb reaches a person or a subagent
- **WHEN** Sunny relays to a roster member, or steers one of its running subagents
- **THEN** it calls the same `message(recipient, text)` tool, and the bus delivers to that entity's mailbox

#### Scenario: Non-roster recipient refused
- **WHEN** `message` is called with a recipient that is neither a roster member nor one of the run's subagents
- **THEN** it is refused

### Requirement: Unified run inspection and cancellation
Sunny SHALL expose `list_runs` and `cancel_run` tools spanning schedules and delegated subagents, scoped by ownership: a caller SHALL see and cancel runs whose derived subject is themselves, and the owner SHALL see and cancel all runs. These SHALL replace schedule-specific list/delete as the general lifecycle surface. Background jobs (`start_job`) have no persisted row and are out of scope until a run ledger exists; the tool description SHALL state this limit.

#### Scenario: List spans schedules and subagents
- **WHEN** Sunny lists runs on behalf of a subject
- **THEN** the result includes that subject's schedules and subagents (background jobs are out of scope until a ledger exists)

#### Scenario: Non-owner cannot cancel another subject's run
- **WHEN** a family member attempts to cancel a run whose subject is someone else
- **THEN** it is refused, while the owner may cancel any run
