# mcp Specification

## Purpose
TBD - created by archiving change mcp-support. Update Purpose after archive.
## Requirements
### Requirement: MCP server registry
Sunny SHALL maintain an MCP server registry that is owner-reviewable and reversible (a file
in the `~/.sunny` git repo, sibling to the credential registry). Each entry SHALL record a
symbolic `name`, the server `url`, the `transport`, an optional `auth` **reference** (a
credential name for header auth, or an OAuth marker), and an `enabled` flag. The registry
SHALL hold references and metadata only and SHALL NOT hold secret values. The set of
registered servers SHALL be changeable only by the owner; Sunny adding/curating an entry is
done on the owner's instruction.

#### Scenario: Entry holds a reference, never a secret
- **WHEN** an MCP server requiring authentication is registered
- **THEN** the registry records the `auth` as a credential name or OAuth marker
- **AND** no secret value is written to the registry

#### Scenario: Owner can review and reverse
- **WHEN** the owner inspects the registry file
- **THEN** it shows each server's name, url, transport, auth reference, and enabled state in plain text under version control

### Requirement: Owner-driven install-and-test lifecycle
Sunny SHALL provide an owner-DM-only `mcp_manage` capability to register, connect, probe,
test, enable, disable, and remove MCP servers. Registering a server SHALL be a request-and-tell
flow: when a server needs authentication Sunny lacks, Sunny SHALL ask the owner for the
details (and to add any backing secret to the owner-controlled vault) rather than invent a
credential. Connecting SHALL enumerate the tools the server exposes (names and descriptions,
without invoking them) and report that inventory to the owner. Testing SHALL invoke a
low-consequence tool (or rely on the probe when no safe call exists) and report the result.

#### Scenario: Add the server the owner names
- **WHEN** the owner asks Sunny to add an MCP server and gives its URL
- **THEN** Sunny records a registry entry for it
- **AND** if the server needs auth Sunny lacks, Sunny asks the owner for it rather than inventing one

#### Scenario: Probe reports the exposed tools
- **WHEN** Sunny connects to a registered server
- **THEN** it enumerates the server's tools without invoking them
- **AND** reports the tool inventory to the owner

#### Scenario: Test before relying on a server
- **WHEN** the owner asks Sunny to test a registered server
- **THEN** Sunny invokes a low-consequence tool (or reports the probe) and returns the outcome

### Requirement: Remote MCP connection over Streamable HTTP
Sunny SHALL connect to registered remote MCP servers over an HTTP-based transport (Streamable
HTTP), wrapping the AI SDK MCP client primitive rather than a hand-rolled protocol
implementation. The transport SHALL refuse HTTP redirects (SSRF hardening) for servers Sunny
does not control. Local stdio (subprocess) MCP servers are out of scope for this capability.

#### Scenario: Connect to a remote server by URL
- **WHEN** Sunny connects to a registered server with an `http` transport
- **THEN** it opens a Streamable-HTTP MCP client to the server's URL via the AI SDK MCP primitive

#### Scenario: Redirects refused
- **WHEN** a remote MCP server responds with an HTTP redirect
- **THEN** the transport refuses to follow it

### Requirement: MCP auth resolved without exposing values to the model
Authentication to an MCP server SHALL be resolved in the connection layer and SHALL NOT be
exposed to the model. For header/bearer auth, the registry's `auth` reference SHALL be a
credential name resolved through the credential registry into the transport's request headers
at connect time. For OAuth, an OAuth client provider SHALL store tokens beside the registry
(never surfaced to the model), drive interactive consent through the browse capability, and
allowlist authorization-server origins before fetching authorization metadata.

#### Scenario: Bearer token injected by name
- **WHEN** a server's `auth` is a credential name
- **THEN** its value is resolved through the registry and placed in the transport headers at connect time
- **AND** the value is never placed in the model's context

#### Scenario: OAuth consent and origin allowlist
- **WHEN** a server uses OAuth and requires consent
- **THEN** consent is driven through the browse capability and the authorization-server origin is checked against an allowlist before metadata is fetched
- **AND** stored tokens are not surfaced to the model

### Requirement: Enabled servers' tools join the agent loop
At turn assembly, Sunny SHALL connect to each enabled MCP server, merge the tools it exposes
into the agent's tool set for that turn, and close the connection after the turn. A server
that fails to connect SHALL degrade gracefully — its tools are absent for that turn, the
failure is logged, and the owner is notified — and SHALL NOT fail the turn. Tools from MCP
servers are native tools injected into the loop; this is a bounded exception to the
bash-centric capability model and applies only to owner-registered servers.

#### Scenario: Enabled server's tools are callable in a turn
- **WHEN** a turn is assembled and a registered server is enabled
- **THEN** that server's exposed tools are present in the agent's tool set for the turn

#### Scenario: Disabled server contributes nothing
- **WHEN** a registered server is disabled
- **THEN** none of its tools are added to the agent's tool set

#### Scenario: Connect failure does not break the turn
- **WHEN** an enabled server cannot be connected at turn assembly
- **THEN** its tools are omitted for that turn, the failure is logged, the owner is notified, and the turn proceeds

### Requirement: MCP tool calls are a deferred gating seam (attended-only until enforced)
MCP tool calls SHALL be treated as a distinct consequence seam at the tool-call layer, because
they are not bash commands and are not seen by the command policy; their enforcement (approval
gating, taint-tracking of results, egress control, drift-pinning) is delivered by
`security-permissions`. Until that enforcement lands, MCP tools SHALL load only on owner DMs
and SHALL NOT be available in autonomous or scheduled runs. MCP tool **results** SHALL be
treated as untrusted content, not as instructions.

#### Scenario: No MCP tools in autonomous runs
- **WHEN** a scheduled or autonomous run is assembled
- **THEN** no MCP server tools are added to its tool set

#### Scenario: MCP result is untrusted
- **WHEN** an MCP tool returns a result into Sunny's context
- **THEN** the result is handled as untrusted data, not as instructions

