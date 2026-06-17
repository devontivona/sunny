## ADDED Requirements

### Requirement: Explicit send-message output model
Sunny SHALL deliver user-facing messages only by an explicit `send_message` action; the model's raw text output SHALL NOT be auto-delivered to the channel. The agent MAY call `send_message` multiple times within a turn, and calling it SHALL NOT end the turn. A turn that calls `send_message` zero times SHALL result in no message to the user (silence). The model's in-step reasoning and any scratchpad/notes SHALL NOT be delivered to the user.

#### Scenario: Only explicit sends reach the user
- **WHEN** the agent produces internal reasoning or scratchpad text during a turn
- **THEN** none of it is delivered to the user
- **AND** the user receives only the content of `send_message` calls

#### Scenario: Multiple sends in one turn
- **WHEN** the agent calls `send_message` more than once in a turn
- **THEN** each call delivers a separate message and the turn continues

#### Scenario: Silence is allowed
- **WHEN** the agent ends a turn without calling `send_message` and there is nothing useful to say
- **THEN** no message is delivered to the user

### Requirement: Guard against unintended silence
The system SHALL reinforce the explicit-send model so a turn does not end silently by accident, and SHALL provide a safety net if it does. Reinforcement SHALL include representing Sunny's prior replies in the model's own history as `send_message` tool calls (not plain assistant text), so the agent's track record demonstrates that speaking means calling `send_message`. As a fallback, if a turn ends with no `send_message` call but produced user-facing text, the system SHALL deliver that text rather than ghosting the user, and SHALL record that the fallback fired (it is expected to trend toward zero).

#### Scenario: History reinforces the send action
- **WHEN** the model prompt is built from prior turns
- **THEN** Sunny's earlier replies appear as `send_message` tool calls with their results, not as plain assistant text

#### Scenario: Fallback delivery on missed send
- **WHEN** a turn ends with no `send_message` call but produced user-facing text
- **THEN** that text is delivered to the user
- **AND** the occurrence is recorded (telemetered) for monitoring

#### Scenario: Sends are not duplicated on resume
- **WHEN** a durable run resumes after interruption
- **THEN** a `send_message` already delivered before the interruption is not delivered again

### Requirement: Turn-grained transcript with retained working context
Sunny SHALL persist its conversation transcript as one stored record per turn, using the AI SDK `UIMessage` as the unit of record (one row = one `UIMessage` = one turn). Each stored record SHALL preserve the turn's structured content — text/scratchpad parts and tool calls with their results — sufficient to reconstruct the model prompt without fabricating tool calls, and SHALL also retain a flattened text projection for keyword recall. Sunny SHALL retain the assistant turn's private working-context (scratchpad) text across turns so a follow-up message can draw on reasoning the agent chose not to deliver. The model prompt SHALL be derived from stored `UIMessage` records (converted to model messages at request time); native provider reasoning blocks are NOT required to be stored.

#### Scenario: One record per turn
- **WHEN** a turn completes (an inbound user message, or Sunny's reply turn)
- **THEN** it is persisted as a single `UIMessage` record carrying that turn's parts

#### Scenario: Prompt reconstructed from stored turns
- **WHEN** Sunny assembles context for a response
- **THEN** the prompt is built by converting stored `UIMessage` records to model messages
- **AND** no `send_message` tool calls are synthesized at prompt-build time

#### Scenario: Working context survives into a follow-up
- **WHEN** Sunny gives a terse reply but retains additional working-context text for that turn
- **AND** the user then asks a follow-up about something not stated in the reply
- **THEN** the retained working context is available in the model prompt for that follow-up

#### Scenario: Native reasoning is not stored
- **WHEN** a turn is persisted
- **THEN** provider reasoning blocks are not required to be stored (scratchpad text is retained instead)

### Requirement: Normalized gateway interface
Sunny's agent core SHALL communicate with all channels through a single normalized gateway interface and SHALL NOT depend directly on any channel SDK or transport library. Inbound messages SHALL be delivered to the agent as a channel-agnostic event containing at least channel, thread identifier, sender identifier, text, attachments, and timestamp. Outbound sends SHALL be expressed against the same interface.

#### Scenario: Agent core is transport-agnostic
- **WHEN** the agent core sends or receives a message
- **THEN** it does so through the normalized gateway interface
- **AND** no channel SDK or transport type is imported into the agent loop

#### Scenario: Inbound message is normalized
- **WHEN** a message arrives on any channel
- **THEN** the gateway delivers it to the agent as a normalized event with channel, thread id, sender id, text, attachments, and timestamp

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
Sunny SHALL persist every inbound and outbound message to its own store (the Postgres message archive) and SHALL build agent context from that store. The system SHALL NOT rely on the messaging transport to provide message history.

#### Scenario: Messages persisted on both directions
- **WHEN** a message is received or sent on any channel
- **THEN** it is written to Sunny's own conversation store

#### Scenario: Context built from own store
- **WHEN** Sunny assembles context for a response
- **THEN** it reads from its own conversation store
- **AND** does not depend on the transport returning prior message history

### Requirement: Per-channel capability flags with graceful degradation
Each channel driver SHALL declare its capabilities (at least: reactions, read receipts, typing indicators, group participation, proactive group messaging). Sunny SHALL feature-detect these capabilities and degrade gracefully rather than assuming any channel's feature set.

#### Scenario: Capability is absent
- **WHEN** Sunny would use a feature a channel does not support (e.g. read receipts)
- **THEN** it omits that feature and still completes the interaction

#### Scenario: Capabilities are queried, not assumed
- **WHEN** a driver is used
- **THEN** Sunny reads its declared capabilities before invoking optional features

### Requirement: Sender authorization and owner tagging
The gateway SHALL authorize inbound messages before the agent acts on them and SHALL tag each message with whether it is from the owner. Messages from outside any authorized context SHALL NOT trigger the agent. Within an authorized group, non-owner participants' messages MAY be answered, but only owner-tagged messages may trigger high-consequence actions or grant approvals (per security-permissions).

#### Scenario: Owner message
- **WHEN** an inbound message is from the owner
- **THEN** the gateway passes it to the agent tagged as owner

#### Scenario: Non-owner in an authorized group
- **WHEN** an inbound message is from a non-owner participant in an authorized group
- **THEN** the gateway passes it tagged as non-owner (answerable, but not action-triggering)

#### Scenario: Unauthorized context
- **WHEN** an inbound message is from outside any authorized context
- **THEN** the gateway does not trigger the agent on it

### Requirement: Direct-message delivery
Over a channel that addresses recipients by a stable identity (e.g. iMessage DMs by phone number), Sunny SHALL be able to both reply to and proactively send direct messages to an authorized user, including after a process restart.

#### Scenario: Proactive DM after restart
- **WHEN** Sunny needs to message Devon directly after a restart (e.g. a scheduled reminder)
- **THEN** it can send the DM using the user's stable address without requiring a prior inbound message in the current session

### Requirement: Group participation
Sunny SHALL be able to participate in group chats: when an inbound group message is received, Sunny SHALL be able to reply to that group. Because the Sendblue transport exposes durable group identifiers, the driver MAY report `proactiveGroup` as supported (initiating to a known group survives restarts).

#### Scenario: Reply in a group
- **WHEN** a message arrives from a group Sunny is part of
- **THEN** Sunny can send a reply to that group

#### Scenario: Group replies survive restarts
- **WHEN** the process restarts and a new group message later arrives
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
