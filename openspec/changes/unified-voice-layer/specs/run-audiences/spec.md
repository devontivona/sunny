# run-audiences Delta Specification

## MODIFIED Requirements

### Requirement: Audience is the logical recipient of a run
Every durable run SHALL have an **Audience** — the logical recipient it is for — that is one of: a **person** (a roster member, keyed by a channel-stable identity), the **household** (record-only; the run may still deliberately message roster members it chooses), a **thread** (an existing conversation), or a **parent** (the run that spawned it). The Audience SHALL be resolved to a delivery Thread at emit time. How a run SPEAKS — its reply/report lane and its addressed messaging tools — SHALL derive from its Audience (the audience axis), never from an authority grant. Audience replaces the fixed `user`/`parent`/`silent` output target everywhere, including standing-schedule definitions.

#### Scenario: Person audience routes to that person's conversation loop
- **WHEN** an autonomous run with a `person` audience produces a terminal report
- **THEN** it is routed to that person's own conversation thread, resolved from the roster, regardless of who created the run

#### Scenario: Household audience is record-only
- **WHEN** a run with a `household` audience completes
- **THEN** its terminal output is recorded without waking any conversation or sending any message, while the run may still have deliberately messaged roster members via its addressed `message` tool

#### Scenario: Parent audience folds back into the spawning run
- **WHEN** a run with a `parent` audience reports
- **THEN** the report is delivered to the spawning run, not to a human

### Requirement: Delivery is a single bus
All outward messaging SHALL go through one delivery seam that resolves an Audience to a Thread and dispatches on the Thread's binding. **Only a conversational turn SHALL deliver text to a human through the gateway** (its reply text, its `message` relays, its `send_image`). An autonomous run's TERMINAL text SHALL be dispatched as an attributed **report**: appended to the resolved thread's inbox and the thread's run-supply woken (for a bound thread, this wakes a normal conversational turn that mediates the report into user-facing speech; for a detached thread, the existing inbox-fold). There SHALL NOT be a separate per-profile terminal-emit path. Every delivered report SHALL carry the sender's identity and lane label (`<label> (subagent)` / `<label> (scheduled)`) so the mediating turn and the recorded history can attribute it. Deliberate addressed fan-out (the `message` tool) remains direct gateway speech from any profile that holds it.

#### Scenario: Scheduled result is mediated, not texted
- **WHEN** a scheduled run with a `person` audience completes with a report
- **THEN** the report is appended to that person's thread as an attributed inbound message and a conversational turn is woken to relay it in voice
- **AND** no gateway send occurs from the scheduled run itself

#### Scenario: Report carries its sender identity and lane
- **WHEN** a subagent or scheduled run reports into a thread
- **THEN** the report is attributed with the run's label and its lane (`(subagent)` / `(scheduled)`), so concurrent reports are distinguishable from each other and from the human

#### Scenario: Silent-success subagent still reports through the bus
- **WHEN** a delegated child completes successfully with a final message
- **THEN** that message is delivered to its parent via the bus (not stranded), closing the delegation watchdog

## REMOVED Requirements

### Requirement: Silence is the absence of a messaging grant
**Reason**: Contradicted by the D-RA14 revision (speech derives from the audience axis, not grants) and by text-as-reply, which made terminal delivery the default effect of ending a turn — "conditional delivery is emergent, with no empty-message convention" is unimplementable in that model and the runtime has necessarily used a sentinel since 2026-07-05.
**Migration**: Structural silence is expressed by the `household` audience (record-only). Per-run conditional silence is expressed by the lane's silence sentinel (see the ADDED voice-layer requirement). A run's result is still always recorded for inspection regardless of silence.

## ADDED Requirements

### Requirement: One derived speech contract (the voice layer)
Every run profile's speech contract SHALL be derived from its RunSpec by one shared builder, in two halves. (a) A generated prompt block SHALL state: who reads the run's final text; that it is delivered verbatim as one message; that a final text containing the lane's silence sentinel delivers nothing (presence means silence — the raw text still persists in the run record); that text between tool calls is private; that inbound messages labeled `(subagent)` or `(scheduled)` are reports from the run's own workers whose sender is NOT the reply's recipient (workers are steered via the addressed `message` tool); and that delivery mechanics are never narrated into the reply. (b) One shared terminal parser SHALL extract report blocks and the sentinel and classify the delivery for every profile. Lanes: a conversational turn is a **speaker** (sentinel `<no-reply/>`); every autonomous run is a **reporter** (sentinel `<no-report/>`). Hand-written per-profile speech contracts and per-profile terminal parsers SHALL NOT exist.

#### Scenario: Same addressing rule in every profile
- **WHEN** any run profile's system prompt is built
- **THEN** it contains the generated voice block for its lane, including the worker-report addressing rule, byte-identical across profiles up to lane and subject substitutions

#### Scenario: Sentinel presence silences the whole reply in every profile
- **WHEN** any run's final text contains its lane's silence sentinel, with or without surrounding text
- **THEN** nothing is delivered, and the raw final text is still recorded in the run's record

#### Scenario: A relay turn folds reports with conversational judgment
- **WHEN** a conversational turn is woken by a worker's report
- **THEN** its reply (if any) addresses its human audience in voice with the thread's context, summarizing what the report means for them — it never replies to the worker through the thread
