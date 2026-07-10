# messaging-gateway (delta)

## MODIFIED Requirements

### Requirement: Self-owned conversation store
Sunny SHALL persist every inbound and outbound message to its own store (the Postgres message archive) and SHALL build agent context from that store. The system SHALL NOT rely on the messaging transport to provide message history. Context assembly SHALL replay a thread's latest compaction summary (when one exists) followed by the verbatim post-watermark tail, per the context-compaction capability; stored message rows SHALL remain immutable under compaction and reachable via recall.

#### Scenario: Messages persisted on both directions
- **WHEN** a message is received or sent on any channel
- **THEN** it is written to Sunny's own conversation store

#### Scenario: Context built from own store
- **WHEN** Sunny assembles context for a response
- **THEN** it reads from its own conversation store — the compaction summary plus verbatim tail for compacted threads, the legacy recent window otherwise
- **AND** does not depend on the transport returning prior message history
