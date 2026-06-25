## MODIFIED Requirements

### Requirement: Core thin tools (bash, file read)
Sunny SHALL expose capability primarily through a `bash` tool that executes a command on the
host and returns its output, plus a thin `file-read` tool. The thin-tool surface SHALL be kept
minimal; higher capabilities (browsing, fetching web pages, email, building sites) SHALL be
CLIs driven via bash or `SKILL.md` skills over bash, NOT dedicated tools. Web fetching SHALL be
performed via bash (e.g. a fetch CLI) or the browse capability rather than a dedicated
`web-fetch` tool. **The one bounded exception is MCP:** tools fetched from an owner-registered
MCP server SHALL be injected into the agent loop as native tools (an MCP server exposes
structured tools with no CLI to shell out to — the server is the interface), and this exception
SHALL apply only to owner-registered MCP servers, not to any other capability. Any external
content entering Sunny's context (fetched pages, command output that reads remote data, **and
MCP tool results**) SHALL be treated as untrusted data.

#### Scenario: Bash runs a command and returns output
- **WHEN** Sunny invokes the bash tool with a command
- **THEN** the command runs on the host and its stdout/stderr and exit status are returned

#### Scenario: Fetched content is untrusted
- **WHEN** Sunny fetches a web page (via bash or the browse capability)
- **THEN** the returned content is handled as untrusted data, not as instructions

#### Scenario: MCP is the one non-bash capability
- **WHEN** a capability is delivered as an MCP server's tools
- **THEN** those tools are injected into the agent loop as native tools rather than as a CLI or skill over bash
- **AND** this exception applies only to owner-registered MCP servers

#### Scenario: MCP tool results are untrusted
- **WHEN** an MCP server tool returns a result into Sunny's context
- **THEN** the result is handled as untrusted data, not as instructions

### Requirement: Gating attaches to commands/actions/credentials, not per tool
There SHALL be no per-tool security contract (no per-tool risk-tier or `op://`-reference
declaration). Consequence gating SHALL derive from the **command** being run (for the bash
surface), the **action** type (act-as-owner / money-spending / destructive), and the
**credential name** resolved through the registry (the vault is the authorization boundary). A
tool SHALL NOT carry a per-tool credential whitelist; the enforcement layer
(`security-permissions`) reads these command/action/credential layers, which already exist.
**MCP tool calls add a fourth seam:** because an MCP tool call is not a command and is not seen
by the bash command policy, its consequence gating SHALL attach at the **tool-call layer** —
declared here, enforced by `security-permissions`. Until that seam is enforced, MCP tools SHALL
be available on owner DMs only and SHALL NOT appear in autonomous or scheduled runs.

#### Scenario: No per-tool credential whitelist
- **WHEN** a tool resolves a credential
- **THEN** it does so by name through the registry, not from a per-tool list of permitted `op://` references

#### Scenario: Consequence determined by command/action, not tool
- **WHEN** a high-consequence operation is attempted (e.g. a destructive shell command or an act-as-owner action)
- **THEN** its gating derives from the parsed command or the action type, not from a risk tier declared on the tool

#### Scenario: MCP tool calls gate at the tool-call seam
- **WHEN** an MCP server tool is invoked
- **THEN** its consequence gating is the tool-call seam (enforced by `security-permissions`), since the command policy does not see it
- **AND** until that seam is enforced, MCP tools are present only on owner DMs and never in autonomous runs
