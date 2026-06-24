## MODIFIED Requirements

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

### Requirement: Per-channel capability flags with graceful degradation
Each channel driver SHALL declare its capabilities (at least: reactions, read receipts, typing indicators, group participation, proactive group messaging, and media/attachments). Sunny SHALL feature-detect these capabilities and degrade gracefully rather than assuming any channel's feature set.

#### Scenario: Capability is absent
- **WHEN** Sunny would use a feature a channel does not support (e.g. read receipts)
- **THEN** it omits that feature and still completes the interaction

#### Scenario: Capabilities are queried, not assumed
- **WHEN** a driver is used
- **THEN** Sunny reads its declared capabilities before invoking optional features

#### Scenario: Media capability gates attachment sends
- **WHEN** Sunny would attach media on a channel whose `media` capability is false
- **THEN** it omits the attachment and still delivers the message text
