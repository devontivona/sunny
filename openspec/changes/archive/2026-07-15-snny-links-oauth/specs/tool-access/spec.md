## ADDED Requirements

### Requirement: Callback-hosting tool is trusted-DM-only
The `oauth_callback` tool (per the `callback-hosting` capability) SHALL be exposed only in trusted owner-DM contexts, alongside `bash`, `credentials`, and `mcp_manage` — never in group threads or to non-owner senders — because it mints live public endpoints on Sunny's domain and its captured parameters flow back into the thread. The tool SHALL be registered in the conversation `buildTools()` wiring and mirrored in the read-only dashboard tool catalog, keeping the two in sync.

#### Scenario: Not available outside the owner DM
- **WHEN** a turn runs for a group thread or a non-owner sender
- **THEN** `oauth_callback` is absent from the tool surface

#### Scenario: Catalog parity
- **WHEN** the dashboard renders the tool catalog
- **THEN** `oauth_callback` appears with the same spec (description, schema) the live wiring uses
