# durable-execution Delta Specification

## MODIFIED Requirements

### Requirement: Two-tier execution model
Sunny SHALL execute work in two tiers: Tier 1 conversational turns for normal message handling, and Tier 2 durable runs for long or asynchronous tasks. Tier-1 turns SHALL run as durable workflow runs (each turn a per-thread run, serialized so a thread processes one turn at a time), so that a conversational turn is observable and resumable on the same durable runtime as Tier-2 runs. **All autonomous work SHALL be mediated**: a delegated subagent's result AND a delivering scheduled run's result return to the audience's conversation thread as an attributed report, and a normal conversational turn mediates it into the user-facing reply. Autonomous runs SHALL NOT deliver directly to the user; only a conversational turn speaks to a human.

#### Scenario: Normal turn runs as a durable per-thread run
- **WHEN** an inbound message arrives on a thread
- **THEN** it is handled by a durable conversational run for that thread, which processes the turn and completes; the next message starts the next turn
- **AND** the run is visible in the workflow runs inspector

#### Scenario: Long task promoted from a conversation is delegated
- **WHEN** the agent determines a conversational task is long-running or asynchronous
- **THEN** it delegates the task to an isolated child run and its own reply just acknowledges the promotion
- **AND** the child's report returns to the conversation thread, where a normal turn summarizes it for the user in the product's voice

#### Scenario: A raw background report never reaches the user unmediated
- **WHEN** any autonomous work — conversation-promoted or scheduled — completes with a long or unformatted result
- **THEN** the user receives a mediating turn's summary of it, not the raw result text

#### Scenario: Scheduled runs are mediated like subagents
- **WHEN** a scheduled run fires and completes with a report for a delivering audience
- **THEN** the report is appended to the audience's conversation thread (attributed `(scheduled)`) and a woken conversational turn relays it with the thread's context and voice — the scheduled run performs no direct gateway send

### Requirement: Configurable output target
Every durable run SHALL be addressed by an **Audience** (the run-audiences capability) — `nobody`, `agent(mailbox)`, or `chat(mailbox)` — rather than a fixed `user`/`parent`/`silent` output target. Delivery SHALL go through the single delivery bus, which resolves the Audience to a Thread. An autonomous run's terminal text SHALL be dispatched as an attributed report (append + wake) — never as a direct gateway send — so a conversation-thread mailbox receives it via a mediating conversational turn and a spawning run's detached inbox without a wake. A `nobody`-audience run's terminal output SHALL be recorded without waking anything (structural silence). A run's terminal message SHALL be delivered through the same bus — not a separate per-profile terminal-emit path — so headless output is never stranded.

#### Scenario: Silent maintenance job sends nothing
- **WHEN** a `nobody`-audience run (e.g. nightly memory consolidation) completes
- **THEN** no message is sent and no conversation is woken, and its result is still recorded for later inspection

#### Scenario: Delegated child reports to its parent
- **WHEN** a run with an `agent(byThread(parent's thread))` audience delivers a message
- **THEN** it is delivered to its spawning run through the bus, not to a human

#### Scenario: Run reports to its audience, not always the owner
- **WHEN** a run with an `agent(byPerson)` audience delivers its result
- **THEN** the report lands on that person's conversation thread and the mediating turn frames its relay for that person, even if that person is not the owner
