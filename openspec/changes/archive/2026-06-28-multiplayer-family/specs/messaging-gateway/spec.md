## ADDED Requirements

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
The set of capabilities (tools) exposed to a turn SHALL be determined by the sender's trust tier, not by the thread kind. A turn whose triggering sender `isTrusted` SHALL receive the elevated capability set (including host-affecting tools such as shell, file read, and task delegation); a turn from a non-trusted sender SHALL NOT. Capabilities reserved as owner-only SHALL remain gated on `isOwner` even for trusted family senders. Editing the owner's own profile document SHALL be one such owner-only capability.

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

## MODIFIED Requirements

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

#### Scenario: Group replies survive restarts
- **WHEN** the process restarts and a new authorized group message later arrives
- **THEN** Sunny can reply to that group

#### Scenario: Proactive group messaging is reported supported
- **WHEN** the iMessage (Sendblue) driver declares capabilities
- **THEN** `proactiveGroup` is reported as supported
