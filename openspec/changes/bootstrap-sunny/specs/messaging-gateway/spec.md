## ADDED Requirements

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
Each channel SHALL be implemented as a driver behind the gateway interface. Adding a new channel SHALL NOT require changes to the agent core. iMessage SHALL be the first channel, provided by the Vercel Chat SDK with Photon's iMessage adapter as the transport.

#### Scenario: Add a channel without touching the agent
- **WHEN** a new channel (e.g. Telegram, email, CLI) is added
- **THEN** it is registered as a new driver behind the gateway interface
- **AND** the agent core is not modified

#### Scenario: iMessage driver
- **WHEN** Sunny communicates over iMessage
- **THEN** it uses the Chat SDK + Photon iMessage transport behind the gateway interface

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
- **WHEN** Sunny would use a feature a channel does not support (e.g. read receipts on Photon)
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

### Requirement: Reactive group participation
Sunny SHALL be able to participate in group chats reactively: when an inbound group message is received, Sunny SHALL be able to reply to that group. On the initial iMessage transport, group handles are session-scoped, so proactive (initiated) group messaging that survives a restart is NOT required and the driver SHALL report `proactiveGroup` as unsupported.

#### Scenario: Reply in a group
- **WHEN** a message arrives from a group Sunny is part of
- **THEN** Sunny can send a reply to that group

#### Scenario: Reactive replies survive restarts
- **WHEN** the process restarts and a new group message later arrives
- **THEN** Sunny can reply to that group using the handle from the new inbound message

#### Scenario: Proactive group messaging is reported unsupported
- **WHEN** the iMessage (Photon) driver declares capabilities
- **THEN** `proactiveGroup` is reported as unsupported

### Requirement: Swappable iMessage transport
The iMessage transport SHALL be replaceable behind the gateway seam without changes to the agent core. Replacing it (e.g. with Sendblue for durable group identifiers) or changing its physical runtime placement (Spectrum Cloud, local macOS, or self-hosted gRPC) SHALL NOT require modifying the agent loop.

#### Scenario: Swap transport for proactive groups
- **WHEN** the iMessage transport is swapped to a provider with durable group IDs
- **THEN** the agent core is unchanged
- **AND** the new driver may report `proactiveGroup` as supported

#### Scenario: Change runtime placement
- **WHEN** the iMessage transport's physical placement changes (e.g. Spectrum Cloud to local macOS)
- **THEN** only the driver/configuration changes and the agent core is unchanged
