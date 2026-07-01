## ADDED Requirements

### Requirement: Audience is the logical recipient of a run
Every durable run SHALL have an **Audience** — the logical recipient it is for — that is one of: a **person** (a roster member, keyed by a channel-stable identity), the **household** (the run may message any roster member it chooses), a **thread** (an existing conversation), or a **parent** (the run that spawned it). The Audience SHALL be resolved to a delivery Thread at emit time. The Audience SHALL be **pure addressing**: it SHALL NOT encode whether the run speaks (that is governed by the run's authority — see "Delivery is tool-driven"). Audience replaces the fixed `user`/`parent` output target.

#### Scenario: Person audience delivers to that person
- **WHEN** a run with a `person` audience produces output
- **THEN** it is delivered to that person's own conversation, resolved from the roster, regardless of who created the run

#### Scenario: Household audience has no delivery mode parameter
- **WHEN** a run is given a `household` audience
- **THEN** the audience alone carries no notion of silence or delivery mode; whether and to whom it speaks depends on the messaging grants in its authority

#### Scenario: Parent audience folds back into the spawning run
- **WHEN** a run with a `parent` audience reports
- **THEN** the report is delivered to the spawning run, not to a human

### Requirement: Delivery is tool-driven; silence is the absence of a messaging grant
A run SHALL reach a human ONLY by invoking a messaging tool, whose destination is resolved from the run's Audience. Whether a run may emit SHALL be governed by its authority: a run not endowed a messaging grant SHALL NOT emit, and SHALL complete silently while still recording its result. There SHALL be no separate `silent` delivery mode on the Audience, and no terminal auto-emit of a run's final text. A run that holds a messaging grant but produced deliverable text without invoking the messaging tool MAY have that output recovered by the delivery backstop.

#### Scenario: A memory-only run is structurally silent
- **WHEN** a run endowed only memory grants (e.g. nightly consolidation) completes
- **THEN** it sends nothing — because it holds no messaging tool — and its result is still recorded for inspection

#### Scenario: Conditional delivery is emergent, not a flag
- **WHEN** a run holding a messaging grant determines no message is warranted (e.g. the reminder condition is not met)
- **THEN** it simply does not invoke the messaging tool, and nothing is delivered — with no empty-message or `silent`-mode convention

#### Scenario: Elicitation miss is caught by the backstop
- **WHEN** a run holding a messaging grant produces deliverable text but does not invoke the messaging tool
- **THEN** the delivery backstop may compose and send that output, the same mechanism used for conversational turns

### Requirement: Delivery grounds out in a channel-bound Thread
A **Thread** SHALL be a durable message log with an OPTIONAL channel binding: **bound** (backed by a messaging adapter — the delivery path to a human) or **detached** (no channel — used as a run's inbox/workspace for steering and logging, never a human destination). Resolving any Audience for actual delivery SHALL terminate at a bound Thread. A detached-audience run that needs to reach a person SHALL resolve that person to their bound Thread and deliver there.

#### Scenario: Household run reaches a person via their bound thread
- **WHEN** a household run chooses to message a roster member
- **THEN** the message is delivered to that member's bound (channel-backed) conversation, and the household run's own detached inbox only logs the action

#### Scenario: Detached inbox is never a human destination
- **WHEN** a run has a detached inbox (a subagent inbox or a household workspace)
- **THEN** no message is delivered to a human through that inbox; it is used only for steering and recording

### Requirement: Principal drives framing and ownership, distinct from Audience
Every run SHALL have a **Principal** — the subject it acts for — which drives its prompt framing, the memory it reads/writes, and its ownership. The Principal MAY differ from the run's creator (a creator may set up a run whose principal is another person). A run SHALL be inspectable and cancellable by its Principal and by the owner; a non-owner SHALL NOT see or cancel runs whose principal is someone else.

#### Scenario: Creator sets up a run for another principal
- **WHEN** the owner creates a reminder whose principal is a family member
- **THEN** the run is framed and owned as that family member's (they can list and cancel it), and the owner can also see and cancel it

#### Scenario: A run is not framed as the owner by default
- **WHEN** a background or scheduled run acts for a family member
- **THEN** it does not introduce itself as the owner's assistant nor address its output to the owner

### Requirement: Runs are one shell over a RunSpec
Conversational turns, background jobs, scheduled jobs, and delegated subagents SHALL execute as the same durable shell over a **RunSpec** of `{ audience, authority, brief, model }`. Prompt framing, loaded context, delivery, and the available tool set SHALL be derived from the RunSpec, not hardcoded per profile.

#### Scenario: The same shell serves every profile
- **WHEN** any of the four run profiles executes
- **THEN** it runs the shared agent shell, differing only in its RunSpec (audience, authority, brief, model)

### Requirement: Authority is attenuated on every spawn (no ambient authority)
Every spawned run SHALL be endowed, explicitly at spawn, with an **authority** set (named tool grants) that is a **subset** of its creator's authority — never broader. A run SHALL NOT acquire authority implicitly from the process environment; a tool existing in-process SHALL NOT be invocable by a run that was not endowed its grant. The spawn relation SHALL form a derivation tree so that authority is monotonically non-increasing along any spawn chain. This generalizes least-privilege child runs to all spawned runs, including scheduled runs.

#### Scenario: A run cannot exceed its endowment
- **WHEN** a run endowed only memory grants attempts a shell command
- **THEN** it is refused, even though the shell tool exists in the process

#### Scenario: Authority shrinks down the spawn chain
- **WHEN** a run spawns a child and the child spawns a grandchild
- **THEN** each descendant's authority is a subset of its parent's, never broader

#### Scenario: Scheduled runs are attenuated rather than special-cased
- **WHEN** a scheduled run is not endowed the schedule-management grant
- **THEN** it cannot create, modify, or delete schedules — enforced by its authority, not a separate anti-recursion check
