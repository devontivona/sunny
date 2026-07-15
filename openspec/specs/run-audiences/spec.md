# run-audiences Specification

## Purpose
Audience-addressed durable runs (unified-voice-layer): every run's audience says WHO READS its final text — nobody (record-only), agent(mailbox) (a conversation loop, as an attributed report), or chat(mailbox) (the thread's people; conversational turns only — the one-speaker rule). Delivery goes through one bus that grounds out in channel-bound Threads, the speech contract (prompt block + terminal parse) is derived per lane by the shared voice layer, ownership derives from the audience, and authority is explicitly attenuated on every spawn.
## Requirements
### Requirement: Audience is who reads a run's final text
Every durable run SHALL have an **Audience** — who reads its final text — that is one of exactly three values: **nobody** (record-only; the run may still deliberately message roster members via the addressed `message` tool), **agent(mailbox)** (the mailbox's conversation loop reads it, as an attributed report), or **chat(mailbox)** (the mailbox's people read it — the run participates in the conversation). A **mailbox** SHALL name a conversation either logically (**byPerson** — a roster member's DM, resolved at delivery time; portable across machines and channel changes) or physically (**byThread** — a specific conversation id; the only way to name a group thread, a creating-thread context, or a worker's detached inbox). `chat` SHALL be constructible only by the router in response to arrivals on a real thread — spawn surfaces SHALL NOT mint it (the one-speaker rule as a constructibility gate). How a run SPEAKS derives from its Audience, never from an authority grant. This three-value Audience replaces the former `thread`/`person`/`parent`/`household` kinds and the `user`/`parent`/`silent` output target everywhere, including standing-schedule definitions (stored encoding: `person:<name>` | `nobody` | `thread:<id>`; `household` accepted as the legacy spelling of `nobody` and normalized on load).

#### Scenario: byPerson mailbox routes to that person's conversation loop
- **WHEN** an autonomous run with an `agent(byPerson)` audience produces a terminal report
- **THEN** it is routed to that person's own conversation thread, resolved from the roster at delivery time, regardless of who created the run

#### Scenario: Nobody audience is record-only
- **WHEN** a run with a `nobody` audience completes
- **THEN** its terminal output is recorded without waking any conversation or sending any message, while the run may still have deliberately messaged roster members via its addressed `message` tool

#### Scenario: A subagent's parent is an agent audience like any other
- **WHEN** a delegated child reports
- **THEN** the report is delivered to `agent(byThread(parent's thread))` — the same mechanism as a scheduled run's report, not a separate `parent` kind

#### Scenario: Spawn surfaces cannot construct chat
- **WHEN** any spawn surface (delegation, scheduling) attempts to address a run's terminal text directly to a conversation's people
- **THEN** it cannot — only `nobody` and `agent` audiences are expressible at spawn; `chat` runs are minted only by the router

### Requirement: Delivery is a single bus
All outward messaging SHALL go through one delivery seam that resolves an Audience's mailbox to a Thread and dispatches on the audience kind. **Only a `chat`-audience run (a conversational turn) SHALL deliver text to a human through the gateway** (its reply text, its `message` relays, its `send_image`). An `agent`-audience delivery SHALL be dispatched as an attributed report: appended to the resolved thread's inbox and — for a real conversation thread — the thread's run-supply woken so a normal conversational turn mediates the report into user-facing speech (a detached worker inbox is appended without waking). There SHALL NOT be a separate per-profile terminal-emit path. Deliberate addressed fan-out (the `message` tool) also rides the bus: the tool resolves its roster recipient, then delivers as chat speech to the resolved DM — so the gateway has exactly ONE speech caller, the bus's chat branch.

#### Scenario: Scheduled result is mediated, not texted
- **WHEN** a scheduled run with an `agent(byPerson)` audience completes with a report
- **THEN** the report is appended to that person's thread as an attributed inbound message and a conversational turn is woken to relay it in voice
- **AND** no gateway send occurs from the scheduled run itself

#### Scenario: Report carries its sender identity and kind
- **WHEN** a subagent or scheduled run reports into a thread
- **THEN** the report is attributed with the run's identity (`(subagent)` / `(scheduled)`), so concurrent reports are distinguishable from each other and from the human

#### Scenario: Silent-success subagent still reports through the bus
- **WHEN** a delegated child completes successfully with a final message
- **THEN** that message is delivered to its parent via the bus (not stranded), closing the delegation watchdog

### Requirement: Delivery grounds out in a channel-bound Thread
A **Thread** SHALL be a durable message log with an OPTIONAL channel binding: **bound** (backed by a messaging adapter — the delivery path to a human) or **detached** (no channel — used as a run's inbox for steering and logging, never a human destination). Resolving any Audience's mailbox for delivery SHALL terminate at a Thread: a `byPerson` mailbox resolves to the person's bound DM (existing, or constructed from the configured send number); a `byThread` mailbox is that thread. A `chat` delivery to a bound thread goes out the gateway; an `agent` delivery is appended as an attributed report (a bound thread's run-supply woken; a detached inbox appended without waking).

#### Scenario: Detached inbox is never a human destination
- **WHEN** a run has a detached inbox (a subagent inbox)
- **THEN** no message is delivered to a human through that inbox; it is used only for steering and recording

#### Scenario: byPerson resolves at fire time, or defers to the owner
- **WHEN** an `agent(byPerson)` mailbox is resolved at delivery time and the person has a bound conversation (or one can be constructed)
- **THEN** delivery goes to that thread's agent
- **AND WHEN** no bound thread can be resolved (the person was removed from the roster and cannot be constructed)
- **THEN** the run's output is not silently dropped — the owner is notified

### Requirement: Ownership derives from the audience
A run's subject (whom it acts for and who owns it) SHALL derive from its **Audience** — `agent(byPerson)`/`chat(byPerson)` → that person, `agent(byThread)`/`chat(byThread)` → the thread's trusted subject (including a subject encoded in the thread id itself, for a conversation that has not yet had an inbound message), `nobody` → the owner — with no separate stored principal. A run SHALL be inspectable and cancellable by its derived subject and by the owner; a non-owner SHALL NOT see or cancel runs whose subject is someone else. Prompt framing and the memory a run reads/writes SHALL follow the same derived subject.

#### Scenario: A family member owns the run created for them
- **WHEN** the owner creates a reminder whose audience is a family member
- **THEN** the run is framed and owned as that family member's (they can list and cancel it), and the owner can also see and cancel it

#### Scenario: A never-contacted family DM frames for its encoded subject
- **WHEN** a relay turn is woken on a family DM that has no inbound history (a person-audience schedule's first report)
- **THEN** the turn derives its participant from the thread-encoded roster identity and frames for that person, not the owner

## REMOVED Requirements

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

### Requirement: Attribution is the run's identity, not its audience
Every run SHALL carry an **identity** (`{ id?, name, kind }`; kind ∈ subagent | scheduled for workers). The delivery bus SHALL stamp every `agent`-audience delivery with the reporting run's identity (`<name> (<kind>): …`) so the mediating turn and the recorded history can attribute reports and steer workers by id. The audience SHALL be pure address — attribution SHALL NOT be encoded in audience values.

#### Scenario: Identity stamps a report
- **WHEN** a worker delivers to an `agent` audience
- **THEN** the appended message is attributed `<identity.name> (<identity.kind>): …`, and an unattributed agent delivery is refused

### Requirement: One derived speech contract (the voice layer)
Every run profile's speech contract SHALL be derived from its RunSpec by one shared builder, in two halves. (a) A generated prompt block SHALL state: who reads the run's final text; that it is delivered verbatim as one message; that a final text containing the lane's silence sentinel delivers nothing (presence means silence — the raw text still persists in the run record); that text between tool calls is private; that inbound messages labeled `(subagent)` or `(scheduled)` are reports from the run's own workers whose sender is NOT the reply's recipient (workers are steered via the addressed `message` tool); and that delivery mechanics are never narrated into the reply. (b) One shared terminal parser SHALL extract report blocks and the sentinel and classify the delivery for every profile. Lanes: a conversational turn is a **speaker** (sentinel `<no-reply/>`); every autonomous run is a **reporter** (sentinel `<no-report/>`, and — reporter tolerance — a reporter final containing `<no-reply/>` is ALSO silence: live prompts, skills, and recorded precedent taught the speaker token before the lane split; speakers stay strict). Hand-written per-profile speech contracts and per-profile terminal parsers SHALL NOT exist.

#### Scenario: Same addressing rule in every profile
- **WHEN** any run profile's system prompt is built
- **THEN** it contains the generated voice block for its lane, including the worker-report addressing rule, byte-identical across profiles up to lane and subject substitutions

#### Scenario: Sentinel presence silences the whole reply in every profile
- **WHEN** any run's final text contains its lane's silence sentinel, with or without surrounding text
- **THEN** nothing is delivered, and the raw final text is still recorded in the run's record

#### Scenario: A relay turn folds reports with conversational judgment
- **WHEN** a conversational turn is woken by a worker's report
- **THEN** its reply (if any) addresses its human audience in voice with the thread's context, summarizing what the report means for them — it never replies to the worker through the thread
