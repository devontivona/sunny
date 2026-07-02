## ADDED Requirements

### Requirement: Audience is the logical recipient of a run
Every durable run SHALL have an **Audience** — the logical recipient it is for — that is one of: a **person** (a roster member, keyed by a channel-stable identity), the **household** (the run may message any roster member it chooses), a **thread** (an existing conversation), or a **parent** (the run that spawned it). The Audience SHALL be resolved to a delivery Thread at emit time. The Audience SHALL be **pure addressing**: it SHALL NOT encode whether the run speaks (that is governed by the run's authority — see "Delivery is a single bus"). Audience replaces the fixed `user`/`parent` output target.

#### Scenario: Person audience delivers to that person
- **WHEN** a run with a `person` audience produces output
- **THEN** it is delivered to that person's own conversation, resolved from the roster, regardless of who created the run

#### Scenario: Household audience has no delivery mode parameter
- **WHEN** a run is given a `household` audience
- **THEN** the audience alone carries no notion of silence or delivery mode; whether and to whom it speaks depends on the messaging grants in its authority

#### Scenario: Parent audience folds back into the spawning run
- **WHEN** a run with a `parent` audience reports
- **THEN** the report is delivered to the spawning run, not to a human

### Requirement: Delivery is a single bus
All outward messaging SHALL go through one delivery seam that resolves an Audience to a Thread and then **dispatches on the Thread's binding**: a **bound** Thread SHALL be delivered via the messaging gateway (reaching a human); a **detached** Thread SHALL be delivered by appending to its inbox and waking its run (reaching an agent-run, folded via the same inbound-steer mechanism as owner double-text). A run's terminal message SHALL be delivered through this same bus to its Audience — there SHALL NOT be a separate per-profile terminal-emit path. Every delivered message SHALL carry the sender's identity (id + label) so a report or relay is attributed to its origin. Inbound consumption (owner double-text, parent→child steering, child→parent report) SHALL remain the single existing inbox-fold; parent→child steering is inbound folding, orthogonal to Audience-based emit.

#### Scenario: Bound vs detached dispatch
- **WHEN** a run delivers to a `bound` Thread
- **THEN** it goes out through the messaging gateway to the human
- **AND WHEN** a run delivers to a `detached` Thread (e.g. a subagent reporting to its parent)
- **THEN** it is appended to that inbox and the recipient run is woken to fold it — no gateway egress

#### Scenario: Silent-success subagent still reports through the bus
- **WHEN** a delegated child completes successfully with a final message
- **THEN** that message is delivered to its parent via the bus (not stranded), closing the delegation watchdog

#### Scenario: Report carries its sender identity
- **WHEN** one of several concurrent subagents reports to a shared parent inbox
- **THEN** the report is attributed to that child (label + id), so the parent can tell reports apart

### Requirement: Silence is the absence of a messaging grant
Whether a run may emit SHALL be governed by its authority: a run not endowed a messaging grant SHALL NOT emit, and SHALL complete silently while still recording its result. There SHALL be no separate `silent` delivery mode on the Audience. A run that holds a messaging grant but produced deliverable text without delivering it MAY have that output recovered by the delivery backstop; the backstop SHALL frame output for the run's subject (derived from its Audience), never hardcoded to the owner.

#### Scenario: A memory-only run is structurally silent
- **WHEN** a run endowed only memory grants (e.g. nightly consolidation) completes
- **THEN** it sends nothing — because it holds no messaging tool — and its result is still recorded for inspection

#### Scenario: Conditional delivery is emergent, not a flag
- **WHEN** a run holding a messaging grant determines no message is warranted (e.g. the reminder condition is not met)
- **THEN** nothing is delivered — with no empty-message or `silent`-mode convention

#### Scenario: Backstop frames for the run's subject
- **WHEN** the delivery backstop recovers output for a run whose audience is a family member
- **THEN** it frames the message for that family member, not for the owner

### Requirement: Delivery grounds out in a channel-bound Thread
A **Thread** SHALL be a durable message log with an OPTIONAL channel binding: **bound** (backed by a messaging adapter — the delivery path to a human) or **detached** (no channel — used as a run's inbox for steering and logging, never a human destination). Resolving any Audience for actual delivery SHALL terminate at a bound Thread. A detached-audience run that needs to reach a person SHALL resolve that person to their bound Thread and deliver there.

#### Scenario: Household run reaches a person via their bound thread
- **WHEN** a household run chooses to message a roster member
- **THEN** the message is delivered to that member's bound (channel-backed) conversation, and the household run's own detached inbox only logs the action

#### Scenario: Detached inbox is never a human destination
- **WHEN** a run has a detached inbox (a subagent inbox or a household detached inbox)
- **THEN** no message is delivered to a human through that inbox; it is used only for steering and recording

#### Scenario: Person audience resolves at fire time, or defers to the owner
- **WHEN** a `person` audience is resolved at fire time and the person has a bound conversation (or one can be constructed)
- **THEN** delivery goes to that bound thread
- **AND WHEN** no bound thread can be resolved (the person has never been in contact, or was removed from the roster)
- **THEN** the run is recorded as undeliverable and the owner is notified — the message is NOT silently dropped

### Requirement: Ownership derives from the audience
A run's subject (whom it acts for and who owns it) SHALL derive from its **Audience** — `person` → that person, `household` → the owner, `thread` → the thread's trusted sender, `parent` → the parent's owner — with no separate stored principal. A run SHALL be inspectable and cancellable by its derived subject and by the owner; a non-owner SHALL NOT see or cancel runs whose subject is someone else. Prompt framing and the memory a run reads/writes SHALL follow the same derived subject.

#### Scenario: A family member owns the run created for them
- **WHEN** the owner creates a reminder whose audience is a family member
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
Every spawned run SHALL be endowed, explicitly at spawn, with an **authority** — a set of grant-name strings — that is a **subset** (by set inclusion) of its creator's authority, never broader. A run SHALL NOT acquire authority implicitly from the process environment; a tool existing in-process SHALL NOT be invocable by a run that was not endowed its grant. Authority SHALL be monotonically non-increasing along any spawn chain. The top-level conversation turn's authority SHALL be reified (from its trust gates) as the root against which the first spawn's subset is checked. This generalizes least-privilege child runs to all spawned runs, including scheduled runs.

#### Scenario: A run cannot exceed its endowment
- **WHEN** a run endowed only memory grants attempts a shell command
- **THEN** it is refused, even though the shell tool exists in the process

#### Scenario: Authority shrinks down the spawn chain
- **WHEN** a run spawns a child and the child spawns a grandchild
- **THEN** each descendant's authority is a subset of its parent's, never broader

#### Scenario: Scheduled runs are attenuated rather than special-cased
- **WHEN** a scheduled run is not endowed the schedule-management grant
- **THEN** it cannot create, modify, or delete schedules — enforced by its authority, not a separate anti-recursion check
