## ADDED Requirements

### Requirement: MCP servers directory on the dashboard
The dashboard SHALL present a read-only **MCP servers** directory, data-driven from the MCP
server registry (and the last cached probe), parallel to the Tools, Credentials, and Skills
directories. For each registered server it SHALL show the `name`, the server **host** (not the
full token-bearing URL), the `transport`, the `auth` reference **by name** (never a value), the
`enabled` state, and the **last-probed tool inventory** (tool names and descriptions). It SHALL
be observe-only, surfacing servers added through `mcp_manage` automatically, and SHALL NOT
display any secret value.

#### Scenario: Registered server appears in the directory
- **WHEN** the owner adds an MCP server through `mcp_manage`
- **THEN** the server appears in the MCP servers directory with its name, host, transport, auth reference, enabled state, and last-probed tools

#### Scenario: No secrets or full credentialed URLs shown
- **WHEN** the MCP servers directory is rendered
- **THEN** it shows the auth reference by name and the server host only
- **AND** no secret value or token-bearing URL is displayed
