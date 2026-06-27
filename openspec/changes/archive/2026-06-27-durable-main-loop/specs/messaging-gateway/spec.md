## MODIFIED Requirements

### Requirement: Per-channel capability flags with graceful degradation
Each channel driver SHALL declare its capabilities (at least: reactions, read receipts, typing indicators, group participation, proactive group messaging). Sunny SHALL feature-detect these capabilities and degrade gracefully rather than assuming any channel's feature set. Where a channel supports typing indicators, Sunny SHALL keep the indicator active for the duration of a conversational turn, refreshing it as the turn makes progress, and SHALL clear it when the turn ends. Refreshing the indicator SHALL be driven from the gateway (which holds the live channel handle), not from inside a durable workflow.

#### Scenario: Capability is absent
- **WHEN** Sunny would use a feature a channel does not support (e.g. read receipts)
- **THEN** it omits that feature and still completes the interaction

#### Scenario: Capabilities are queried, not assumed
- **WHEN** a driver is used
- **THEN** Sunny reads its declared capabilities before invoking optional features

#### Scenario: Typing indicator persists across a long turn
- **WHEN** a conversational turn runs for multiple steps on a channel that supports typing
- **THEN** the gateway refreshes the typing indicator as the turn progresses
- **AND** clears it once the turn completes

### Requirement: Direct-message delivery
Over a channel that addresses recipients by a stable identity (e.g. iMessage DMs by phone number), Sunny SHALL be able to both reply to and proactively send direct messages to an authorized user, including after a process restart and from within a durable conversational turn. Outbound delivery SHALL address the recipient by stable identity and SHALL NOT depend on a live in-process session handle, so that a send issued from a durable step succeeds the same way a proactive send does.

#### Scenario: Proactive DM after restart
- **WHEN** Sunny needs to message Devon directly after a restart (e.g. a scheduled reminder)
- **THEN** it can send the DM using the user's stable address without requiring a prior inbound message in the current session

#### Scenario: Reply sent from a durable turn step
- **WHEN** a conversational turn delivers a reply from within a durable step
- **THEN** the message is sent by addressing the thread's stable identity without a live session handle
- **AND** if that step is replayed after a crash, the message is not sent a second time
