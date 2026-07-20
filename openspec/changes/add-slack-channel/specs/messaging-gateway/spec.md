# messaging-gateway Specification (delta)

## ADDED Requirements

### Requirement: Per-channel webhook dispatch
When multiple webhook-based channel drivers are live, each channel's webhook route SHALL dispatch to that channel's own driver. The multi-channel gateway SHALL expose per-channel driver resolution so routes address their channel explicitly; webhooks SHALL NOT be funneled through a single primary driver.

#### Scenario: Two live webhook channels
- **WHEN** both the iMessage and Slack drivers are configured and each platform posts to its own webhook route
- **THEN** each request is verified and handled by its own driver, and neither channel's traffic reaches the other driver

#### Scenario: Outbound routing by thread id
- **WHEN** the agent sends to a thread whose id carries a channel prefix
- **THEN** the multi-channel gateway routes the send to the driver owning that prefix

### Requirement: Proactive speech resolves to the home channel
Proactive and person-addressed delivery — scheduled runs, owner notifications, and relays to roster members — SHALL resolve to the person's home channel, which is iMessage for all roster members. Secondary channels SHALL carry only conversations they initiated (inbound message → reply lane in that thread). A future per-person home-channel policy MUST consciously supersede this requirement rather than being implied by a channel's existence.

#### Scenario: Schedule speaks on iMessage
- **WHEN** a scheduled run addresses the owner while Slack is configured
- **THEN** the message is delivered to the owner's iMessage DM, not Slack

#### Scenario: Slack turn replies on Slack
- **WHEN** a turn was initiated by an inbound Slack DM
- **THEN** its reply-lane speech is delivered to that Slack thread

#### Scenario: Relay ignores secondary channels
- **WHEN** Sunny relays a message to a roster member
- **THEN** the relay resolves to the member's iMessage identity regardless of other configured channels
