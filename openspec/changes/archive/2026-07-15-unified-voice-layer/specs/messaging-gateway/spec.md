# messaging-gateway Delta Specification

## MODIFIED Requirements

### Requirement: Text-as-reply delivery model
Sunny's reply SHALL be the model's FINAL text: the text a conversational turn ends on (after its last tool call) SHALL be delivered to the user as one iMessage, blank lines preserved (bubble-splitting was removed 2026-07-05 as too noisy). Interim text written between tool calls (working notes) SHALL NOT be delivered raw; it is source material for relayed progress updates. The model SHALL choose silence with the `<no-reply/>` sentinel, whose PRESENCE anywhere in the final text silences the whole reply (production runs show the model writes the token to mean "don't send this" for the entire reply — surrounding text is self-narration, not a message); the raw final text persists in the turn record for inspection and as same-modality silence precedent. The model's private reasoning SHALL NOT be delivered. Outbound images SHALL be sent via an explicit `send_image` tool (path or URL, never raw bytes). The turn's speech contract (verbatim-one-message, sentinel semantics, private interim text, worker-report addressing) SHALL be supplied by the shared voice layer (run-audiences), not hand-written per profile.

Rationale (PR #30/#31, 2026-07): a tool-mediated voice (`send_message`-only) fights the trained prior that final text answers the user, and in a rolling-window chat it is self-poisoning via history imitation (clean-history delivery ~100% vs ~28% under poisoned precedent). Text-as-reply makes the trained prior the correct behavior, so persisted history is self-reinforcing; measured 100% delivery across the migration gates, including all poisoned-history probes. Presence-means-silence (PR #73, 2026-07-13) replaced strip-and-deliver after heartbeat runs delivered working notes with the token appended.

#### Scenario: The final text is the reply
- **WHEN** a turn ends on plain text after completing its tool work
- **THEN** that text is delivered to the user as one message, formatting preserved
- **AND** interim narration written between tool calls is not delivered raw

#### Scenario: Silence by sentinel
- **WHEN** the model replies with exactly `<no-reply/>`
- **THEN** no message is delivered to the user
- **AND** the sentinel persists in the turn record as same-modality silence precedent

#### Scenario: Sentinel presence silences the whole reply
- **WHEN** the final text contains the `<no-reply/>` sentinel alongside other text
- **THEN** nothing is delivered, and the raw final text (notes and sentinel included) persists in the turn record

#### Scenario: Interim progress on long turns
- **WHEN** a turn runs multiple tool steps
- **THEN** a cheap utility model MAY relay short progress updates composed from the turn's working notes and tool-call log (first on the first non-terminal step, then on a configured cadence)
- **AND** the relay declines (silence) when there is no user-relevant news
- **AND** relayed updates persist on the turn record and render attributed (or excluded, per config) when the turn replays as history

## ADDED Requirements

### Requirement: Worker reports are folded, never answered through the thread
Inbound messages attributed to the turn's own workers (`<label> (subagent):` / `<label> (scheduled):`) SHALL be treated as reports, not as the conversational counterpart: the woken turn's reply (if any) addresses the thread's human — summarizing, with the thread's context, what the report means for them — and SHALL NOT address the worker through the thread. A turn that needs to answer or steer a worker SHALL use the addressed `message` tool with the worker's id. A turn woken by a report MAY reply `<no-reply/>` when the report warrants no user-facing relay (low-value update, content already discussed in the live conversation, or an active exchange it should not interrupt).

#### Scenario: A blocker report is relayed, not answered in-thread
- **WHEN** a worker's report states a blocker addressed to its orchestrator
- **THEN** the woken turn steers the worker via `message` (if a steer is needed) and its thread reply, if any, tells the human what changed — the thread never carries text addressed to the worker

#### Scenario: A redundant report is folded silently
- **WHEN** a report arrives whose content the live conversation just covered
- **THEN** the turn may reply `<no-reply/>`, and the report still persists in the thread record
