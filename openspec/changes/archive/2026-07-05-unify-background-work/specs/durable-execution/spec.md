## MODIFIED Requirements

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
