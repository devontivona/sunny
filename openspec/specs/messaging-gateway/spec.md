# messaging-gateway Specification

## Purpose
TBD - created by archiving change bootstrap-sunny. Update Purpose after archive.
## Requirements
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

### Requirement: Abnormal-turn-end backstop
A deliberate turn always ends on reply text or the silence sentinel; if a turn instead ends ABNORMALLY — cut off by the step limit, a length cap, or an error finish — with working notes but no reply, the system SHALL NOT ghost the user: a cheap utility model SHALL compose an honest status message from the turn's notes ("here's where things stand"), returned as plain text (never a forced tool call), which the system delivers and persists as the turn's final reply text (a plain text part — never a synthetic tool call). The backstop SHALL NOT claim or imply the task completed when the notes show it didn't, and SHALL NOT have a silence option. Each firing SHALL be recorded (telemetered as `turn-backstop`, surfaced in the dashboard as recovered) and is expected to be rare.

#### Scenario: Backstop on a cut-off turn
- **WHEN** a turn ends with working notes but no final reply text and no silence sentinel
- **THEN** the backstop composes an honest status message from the notes and delivers it
- **AND** the composed text persists as the turn's final reply text
- **AND** the occurrence is recorded (telemetered) for monitoring

#### Scenario: Unfinished work is reported honestly
- **WHEN** the cut-off turn's notes show the task did not complete
- **THEN** the backstop message says what got done and what didn't, without implying completion

#### Scenario: Sends are not duplicated on resume
- **WHEN** a durable run resumes after interruption
- **THEN** a message already delivered before the interruption is not delivered again

### Requirement: Turn-grained transcript with retained working context
Sunny SHALL persist its conversation transcript as one stored record per turn, using the AI SDK `UIMessage` as the unit of record (one row = one `UIMessage` = one turn). Each stored record SHALL preserve the turn's structured content — text/scratchpad parts and tool calls with their results — sufficient to reconstruct the model prompt without fabricating tool calls, and SHALL also retain a flattened text projection for keyword recall. Sunny SHALL retain the assistant turn's private working-context (scratchpad) text across turns so a follow-up message can draw on reasoning the agent chose not to deliver. The model prompt SHALL be derived from stored `UIMessage` records (converted to model messages at request time); native provider reasoning blocks are NOT required to be stored.

#### Scenario: One record per turn
- **WHEN** a turn completes (an inbound user message, or Sunny's reply turn)
- **THEN** it is persisted as a single `UIMessage` record carrying that turn's parts

#### Scenario: Prompt reconstructed from stored turns
- **WHEN** Sunny assembles context for a response
- **THEN** the prompt is built by converting stored `UIMessage` records to model messages
- **AND** no tool calls are synthesized at prompt-build time (delivered replies replay as the turn's final text)

#### Scenario: Working context survives into a follow-up
- **WHEN** Sunny gives a terse reply but retains additional working-context text for that turn
- **AND** the user then asks a follow-up about something not stated in the reply
- **THEN** the retained working context is available in the model prompt for that follow-up

#### Scenario: Native reasoning is not stored
- **WHEN** a turn is persisted
- **THEN** provider reasoning blocks are not required to be stored (scratchpad text is retained instead)

### Requirement: Normalized gateway interface
Sunny's agent core SHALL communicate with all channels through a single normalized gateway interface and SHALL NOT depend directly on any channel SDK or transport library. Inbound messages SHALL be delivered to the agent as a channel-agnostic event containing at least channel, thread identifier, sender identifier, text, attachments, and timestamp. Inbound attachments SHALL carry enough information to retrieve their content (not metadata alone), and SHALL be consumed — not discarded — by the agent. Outbound sends SHALL be expressed against the same interface, and that interface SHALL be able to carry an outbound attachment in addition to text.

#### Scenario: Agent core is transport-agnostic
- **WHEN** the agent core sends or receives a message
- **THEN** it does so through the normalized gateway interface
- **AND** no channel SDK or transport type is imported into the agent loop

#### Scenario: Inbound message is normalized
- **WHEN** a message arrives on any channel
- **THEN** the gateway delivers it to the agent as a normalized event with channel, thread id, sender id, text, attachments, and timestamp

#### Scenario: Inbound attachment content is retrievable
- **WHEN** an inbound message carries an attachment
- **THEN** the normalized attachment exposes a way to obtain its bytes, so the agent layer can persist and use the content rather than only its metadata

#### Scenario: Outbound attachment is expressible
- **WHEN** the agent core sends a message with an attachment
- **THEN** the normalized outbound interface carries the attachment alongside the text

### Requirement: Pluggable channel drivers
Each channel SHALL be implemented as a driver behind the gateway interface. Adding a new channel SHALL NOT require changes to the agent core. iMessage SHALL be the first channel, provided by the Vercel Chat SDK with the Sendblue iMessage adapter as the transport.

#### Scenario: Add a channel without touching the agent
- **WHEN** a new channel (e.g. Telegram, email, CLI) is added
- **THEN** it is registered as a new driver behind the gateway interface
- **AND** the agent core is not modified

#### Scenario: iMessage driver
- **WHEN** Sunny communicates over iMessage
- **THEN** it uses the Chat SDK + Sendblue iMessage transport behind the gateway interface

### Requirement: Self-owned conversation store
Sunny SHALL persist every inbound and outbound message to its own store (the Postgres message archive) and SHALL build agent context from that store. The system SHALL NOT rely on the messaging transport to provide message history. Context assembly SHALL replay a thread's latest compaction summary (when one exists) followed by the verbatim post-watermark tail, per the context-compaction capability; stored message rows SHALL remain immutable under compaction and reachable via recall.

#### Scenario: Messages persisted on both directions
- **WHEN** a message is received or sent on any channel
- **THEN** it is written to Sunny's own conversation store

#### Scenario: Context built from own store
- **WHEN** Sunny assembles context for a response
- **THEN** it reads from its own conversation store — the compaction summary plus verbatim tail for compacted threads, the legacy recent window otherwise
- **AND** does not depend on the transport returning prior message history

### Requirement: Per-channel capability flags with graceful degradation
Each channel driver SHALL declare its capabilities (at least: reactions, read receipts, typing indicators, group participation, proactive group messaging, and media/attachments). Sunny SHALL feature-detect these capabilities and degrade gracefully rather than assuming any channel's feature set. Where a channel supports typing indicators, Sunny SHALL keep the indicator active for the duration of a conversational turn, refreshing it as the turn makes progress, and SHALL clear it when the turn ends. Refreshing the indicator SHALL be driven from the gateway (which holds the live channel handle), not from inside a durable workflow.

#### Scenario: Capability is absent
- **WHEN** Sunny would use a feature a channel does not support (e.g. read receipts)
- **THEN** it omits that feature and still completes the interaction

#### Scenario: Capabilities are queried, not assumed
- **WHEN** a driver is used
- **THEN** Sunny reads its declared capabilities before invoking optional features

#### Scenario: Media capability gates attachment sends
- **WHEN** Sunny would attach media on a channel whose `media` capability is false
- **THEN** it omits the attachment and still delivers the message text

#### Scenario: Typing indicator persists across a long turn
- **WHEN** a conversational turn runs for multiple steps on a channel that supports typing
- **THEN** the gateway refreshes the typing indicator as the turn progresses
- **AND** clears it once the turn completes

### Requirement: Sender authorization and owner tagging
The gateway SHALL authorize inbound messages before the agent acts on them and SHALL tag each message with its sender's trust tier (`isTrusted`) and whether it is from the owner (`isOwner`). A direct message SHALL be authorized only if its sender is trusted (owner or family); a non-trusted direct message SHALL NOT trigger the agent. Authorization of group messages is governed by the Group participation requirement. Messages from outside any authorized context SHALL NOT trigger the agent. Only owner-tagged messages may trigger owner-only capabilities or (per security-permissions, when added) grant approvals.

#### Scenario: Owner message
- **WHEN** an inbound message is from the owner
- **THEN** the gateway passes it to the agent tagged as owner (and trusted)

#### Scenario: Family direct message is authorized
- **WHEN** an inbound direct message is from a trusted family member
- **THEN** the gateway authorizes it and passes it tagged as trusted, non-owner

#### Scenario: Non-trusted direct message
- **WHEN** an inbound direct message is from a sender who is neither owner nor family
- **THEN** the gateway does not trigger the agent on it

#### Scenario: Unauthorized context
- **WHEN** an inbound message is from outside any authorized context
- **THEN** the gateway does not trigger the agent on it

### Requirement: Family roster and trust tiers
The gateway SHALL resolve each inbound sender to a trust tier derived from configuration. Configuration SHALL define the owner and a `family` roster, each entry carrying a display name and one or more stable identities (phone/email), matched using the same identity normalization applied to the owner. A sender whose identity matches the owner SHALL resolve to role `owner`; a sender matching a family entry SHALL resolve to role `family`; any other sender SHALL resolve to no trusted role. The gateway SHALL expose a derived `isTrusted` signal that is true for both `owner` and `family`, and SHALL continue to expose `isOwner` meaning specifically the owner, so that owner-only carve-outs remain expressible. The roster SHALL be structured so additional, lower-trust tiers (e.g. `friend`) can be added later as data without a schema change. This change does not add cryptographic identity pairing; identity remains the channel-stable address (phone/email), the same trust class already used for the owner.

#### Scenario: Family identity resolves to the family tier
- **WHEN** an inbound message arrives from an identity listed in the `family` roster
- **THEN** the gateway resolves the sender to role `family`
- **AND** marks the message `isTrusted` true and `isOwner` false

#### Scenario: Owner remains distinguishable from family
- **WHEN** an inbound message arrives from an owner identity
- **THEN** the gateway resolves the sender to role `owner`
- **AND** marks the message both `isTrusted` and `isOwner` true

#### Scenario: Identity matching tolerates formatting
- **WHEN** a roster identity and an inbound sender differ only in phone/email formatting (spacing, punctuation, case)
- **THEN** they are treated as the same identity

### Requirement: Capability exposure follows trust tier
The set of capabilities (tools) exposed to a turn SHALL be determined by the sender's trust tier, not by the thread kind. A turn whose triggering sender `isTrusted` SHALL receive the elevated capability set (including host-affecting tools such as shell, file read, and task delegation); a turn from a non-trusted sender SHALL NOT. Capabilities reserved as owner-only SHALL remain gated on `isOwner` even for trusted family senders. Editing the owner-only core memory files — the owner's profile (`USER.md`) and Sunny's operating notes (`SUNNY.md`) — SHALL be such owner-only capabilities.

#### Scenario: Family DM gets elevated capabilities
- **WHEN** a trusted family member sends a direct message
- **THEN** the turn is granted the elevated capability set (the same powerful tools the owner receives in a DM)

#### Scenario: Owner-only capability stays owner-only for family
- **WHEN** a trusted family member attempts an action reserved as owner-only (e.g. editing the owner's profile document)
- **THEN** that action is not available to them, even though they are trusted

### Requirement: Relayed messages to roster members
Sunny SHALL be able to send a message to another person in the trusted roster (owner or family) on the requesting user's behalf — a relay to a thread other than the current one (e.g. "text Kate that I say hi"). The relay MAY carry a single optional image attachment (a local file path or URL), delivered the same way as a normal outbound image (hosted/sent by the gateway, degrading to text where the channel/thread does not support media). Recipients SHALL be restricted to the roster: a request to message an identity that is not the owner or a family member SHALL be refused without sending. The relayed message SHALL be delivered to, and recorded in, the recipient's own conversation (addressing an existing direct-message thread when one exists, otherwise a newly addressed one). Messaging arbitrary, non-roster recipients is out of scope for this change (an act-as-owner capability gated by security-permissions). This relay capability SHALL be available only on turns that already receive the elevated toolset (trusted direct messages).

#### Scenario: Relay to a roster member
- **WHEN** a trusted user asks Sunny to text another roster member
- **THEN** Sunny sends the message to that person's own conversation
- **AND** confirms back to the requesting user

#### Scenario: Relay an image to a roster member
- **WHEN** a trusted user asks Sunny to send a roster member an image (e.g. an approved generated picture)
- **THEN** Sunny relays the message with the image attached to that person's own conversation

#### Scenario: Non-roster recipient refused
- **WHEN** a user asks Sunny to text an identity that is not the owner or a family member
- **THEN** Sunny does not send anything and says it can only message roster members

### Requirement: Direct-message delivery
Over a channel that addresses recipients by a stable identity (e.g. iMessage DMs by phone number), Sunny SHALL be able to both reply to and proactively send direct messages to an authorized user, including after a process restart and from within a durable conversational turn. Outbound delivery SHALL address the recipient by stable identity and SHALL NOT depend on a live in-process session handle, so that a send issued from a durable step succeeds the same way a proactive send does.

#### Scenario: Proactive DM after restart
- **WHEN** Sunny needs to message Devon directly after a restart (e.g. a scheduled reminder)
- **THEN** it can send the DM using the user's stable address without requiring a prior inbound message in the current session

#### Scenario: Reply sent from a durable turn step
- **WHEN** a conversational turn delivers a reply from within a durable step
- **THEN** the message is sent by addressing the thread's stable identity without a live session handle
- **AND** if that step is replayed after a crash, the message is not sent a second time

### Requirement: Group participation
Sunny SHALL participate only in groups whose every participant is trusted (owner or family); the owner need not be a participant. The gateway SHALL determine group membership from the transport's participant roster and SHALL re-check it on every inbound group message. If any participant is not trusted, the gateway SHALL NOT trigger the agent for that group (the whole group is silenced, not merely the outsider's messages). If the participant roster cannot be determined for a group message, the gateway SHALL fail closed and not trigger the agent. For an authorized (all-trusted) group, Sunny SHALL be able to reply to the group, and participation SHALL NOT require an explicit @mention: the gateway SHALL deliver authorized group messages to the agent, which decides per turn whether to respond or stay silent. Because the Sendblue transport exposes durable group identifiers, the driver MAY report `proactiveGroup` as supported (initiating to a known group survives restarts).

#### Scenario: All-trusted group is answered without a mention
- **WHEN** a message arrives in a group whose participants are all trusted (owner and/or family)
- **THEN** the gateway delivers it to the agent even though Sunny was not @mentioned
- **AND** the agent decides per turn whether to reply or stay silent

#### Scenario: Group with an outsider is silenced
- **WHEN** an inbound group message arrives and at least one participant is not trusted
- **THEN** the gateway does not trigger the agent for any message in that group

#### Scenario: Outsider added mid-thread silences the group
- **WHEN** a previously all-trusted group gains a non-trusted participant
- **THEN** the next message re-checks membership and the gateway stops triggering the agent for that group

#### Scenario: Roster unavailable fails closed
- **WHEN** the participant roster cannot be retrieved for an inbound group message
- **THEN** the gateway treats the group as unauthorized and does not trigger the agent

#### Scenario: Family-only group without the owner
- **WHEN** a group's participants are all family members and the owner is not among them
- **THEN** the group is authorized and Sunny may participate

#### Scenario: Reply in a group
- **WHEN** a message arrives from a group Sunny is part of
- **THEN** Sunny can send a reply to that group

#### Scenario: Group replies survive restarts
- **WHEN** the process restarts and a new authorized group message later arrives
- **THEN** Sunny can reply to that group

#### Scenario: Proactive group messaging is reported supported
- **WHEN** the iMessage (Sendblue) driver declares capabilities
- **THEN** `proactiveGroup` is reported as supported

### Requirement: Swappable iMessage transport
The iMessage transport SHALL be replaceable behind the gateway seam without changes to the agent core. Replacing it (e.g. with a different provider, or a self-hosted bridge) or changing its physical runtime placement SHALL NOT require modifying the agent loop.

#### Scenario: Swap transport
- **WHEN** the iMessage transport is swapped to a different provider
- **THEN** the agent core is unchanged
- **AND** the new driver declares its own capabilities

#### Scenario: Change runtime placement
- **WHEN** the iMessage transport's physical placement changes (e.g. Sendblue to a local macOS bridge)
- **THEN** only the driver/configuration changes and the agent core is unchanged

### Requirement: Worker reports are folded, never answered through the thread
Inbound messages attributed to the turn's own workers (`<label> (subagent):` / `<label> (scheduled):`) SHALL be treated as reports, not as the conversational counterpart: the woken turn's reply (if any) addresses the thread's human — summarizing, with the thread's context, what the report means for them — and SHALL NOT address the worker through the thread. A turn that needs to answer or steer a worker SHALL use the addressed `message` tool with the worker's id. A turn woken by a report MAY reply `<no-reply/>` when the report warrants no user-facing relay (low-value update, content already discussed in the live conversation, or an active exchange it should not interrupt).

#### Scenario: A blocker report is relayed, not answered in-thread
- **WHEN** a worker's report states a blocker addressed to its orchestrator
- **THEN** the woken turn steers the worker via `message` (if a steer is needed) and its thread reply, if any, tells the human what changed — the thread never carries text addressed to the worker

#### Scenario: A redundant report is folded silently
- **WHEN** a report arrives whose content the live conversation just covered
- **THEN** the turn may reply `<no-reply/>`, and the report still persists in the thread record

### Requirement: Outbound text passes through the short-link rewrite
All outbound message text SHALL pass through the short-link rewrite (per the `short-links` capability) inside the Sendblue transport driver immediately before handing text to the adapter, so that every outbound lane — terminal replies, recovery backstop, translator progress updates, proactive/scheduled sends, undeliverable-person notices, and the group-thread image-URL append — is covered by one seam. The rewrite SHALL occur after all other text finalization (e.g. media-URL appends) so no later step reintroduces long URLs. Persisted transcript history SHALL retain the original long URLs; only the wire text carries short links.

#### Scenario: Group image append is shortened
- **WHEN** an image is sent to a group thread and the driver appends the public media URL as plaintext
- **THEN** the appended URL is delivered as a short link

#### Scenario: Transcript keeps the original URL
- **WHEN** a reply containing a long URL is delivered as a short link
- **THEN** the persisted turn history and model-facing context contain the original long URL, not the short link

