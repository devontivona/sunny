# slack-channel Specification (delta)

## ADDED Requirements

### Requirement: Slack DM conversations drive full agent turns
The system SHALL provide a Slack channel driver implementing the normalized `Gateway` interface, wrapping the official Chat SDK Slack adapter. A direct message from the owner's Slack identity SHALL be normalized to a `ChannelEvent` and drive the same conversational turn loop as iMessage, with no agent-core changes. Conversation granularity SHALL follow Chat SDK norms: thread ids are `slack:<channelId>:<thread_ts>`, each Slack thread is its own conversation, top-level DM messages start conversations and thread replies continue them.

#### Scenario: Owner DM round-trip
- **WHEN** the owner sends Sunny a Slack DM
- **THEN** a conversational turn runs and the reply is posted back into the same Slack thread

#### Scenario: Slack threads read as non-group
- **WHEN** any v1 Slack thread id is tested for group-ness
- **THEN** it reads as non-group under the existing thread-id convention, with no changes to the shared thread-id helpers

#### Scenario: No coalescing delay
- **WHEN** a Slack message event arrives
- **THEN** the turn starts without the multipart quiet-window wait used for iMessage, because Slack delivers one event per message

### Requirement: Owner-only authorization, fail-closed
The driver SHALL resolve Slack sender ids against the existing roster identities (the owner's Slack member id added as identity data, no schema change). In v1 only owner DMs SHALL dispatch turns. DMs from any other workspace member SHALL be dropped without a reply (logged, no information leak). Channel messages and @mentions SHALL be received but never dispatched while their participants are unrostered.

#### Scenario: Non-owner DM stays silent
- **WHEN** a workspace member who is not on the roster DMs the Slack bot
- **THEN** no turn runs and no reply is sent, and the drop is observable in logs

#### Scenario: Channel mention stays silent in v1
- **WHEN** the bot is @mentioned in a workspace channel
- **THEN** the event is accepted (webhook 200) but no turn runs and nothing is posted

### Requirement: Slack webhook handling
The system SHALL expose a Slack Events API webhook route that dispatches to the Slack driver's `handleWebhook`. The driver SHALL verify Slack request signatures, answer Slack's URL-verification challenge, and acknowledge events within Slack's deadline. Redelivered events (Slack retries) SHALL be idempotent: at most one turn runs per distinct inbound message, backed by the store's `(channel, messageId)` uniqueness.

#### Scenario: URL verification handshake
- **WHEN** Slack sends a `url_verification` challenge to the webhook
- **THEN** the challenge value is echoed back and the endpoint is accepted by Slack

#### Scenario: Retried event does not double-process
- **WHEN** Slack redelivers an event for a message that was already ingested
- **THEN** no duplicate inbound row is stored and no second turn is driven for it

#### Scenario: Bad signature rejected
- **WHEN** a request with an invalid Slack signature hits the webhook
- **THEN** it is rejected without reaching the dispatch pipeline

### Requirement: Reply-lane parity
Slack conversations SHALL support the full reply lane: multiple sends within one turn (interim updates, final reply, backstop notices), per-thread send serialization, and the mandatory outbound short-link rewrite. Sends are posted as discrete messages (no token streaming). Typing indication SHALL be bridged best-effort from the router's existing typing hooks and degrade to a no-op where the platform surface is absent. A successful Slack post SHALL be treated as terminal delivery (no asynchronous delivery-status tracking).

#### Scenario: Interim update mid-turn
- **WHEN** a long turn emits an interim progress message before its final reply
- **THEN** both arrive in the Slack thread as separate messages, in order

#### Scenario: Outbound text is short-link rewritten
- **WHEN** a Slack reply contains a long local-media or callback URL
- **THEN** the posted text carries the rewritten short link, while the transcript keeps the original

#### Scenario: Send failure surfaces immediately
- **WHEN** a Slack post fails at the API
- **THEN** the failure is reported through the send result path in the same turn, with no delivery-callback retry machinery

### Requirement: Media over authenticated Slack APIs
Inbound Slack file attachments SHALL be fetched with authenticated requests and persisted promptly through the existing attachment pipeline. Outbound attachments SHALL be uploaded via Slack's file APIs. The public tokenized media route SHALL NOT be used for Slack in either direction.

#### Scenario: Inbound image
- **WHEN** the owner sends an image in a Slack DM
- **THEN** its bytes are fetched with the bot token, persisted, and visible to the model like an iMessage image

#### Scenario: Outbound image
- **WHEN** a turn sends an image to a Slack conversation
- **THEN** it is uploaded natively to the thread and no public media URL is minted

### Requirement: Configuration-gated boot and future-group posture
The Slack driver SHALL be optional at boot: absent Slack credentials, the system runs exactly as before. The Slack app manifest SHALL request mention and channel-history scopes up front so future group participation is a roster/policy change, not a re-install — while all such traffic stays silent under fail-closed authorization until then.

#### Scenario: Boot without Slack configured
- **WHEN** Slack credentials are not set
- **THEN** the runtime boots with the existing channels only and no Slack driver or route errors

#### Scenario: Disabling Slack
- **WHEN** Slack credentials are removed and the service restarts
- **THEN** Slack traffic is no longer processed while iMessage behavior is unaffected
