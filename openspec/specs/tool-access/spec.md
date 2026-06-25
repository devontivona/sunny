# tool-access Specification

## Purpose
TBD - created by syncing change agent-tooling. Update Purpose after archive.
## Requirements
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

### Requirement: Per-command credential injection
Secrets SHALL be injected into the specific command invocation that needs them: the model names a credential (resolved through the registry, D-CR5), and its value is resolved into that subprocess's environment at execution time. The value SHALL NOT be exposed to the model or placed in the model's context, SHALL reach only that subprocess, and SHALL be masked from the command's returned output.

#### Scenario: Secret bound to one command only
- **WHEN** a command needs a credential
- **THEN** the value is resolved into that subprocess's environment at run time
- **AND** is not visible to the model or to other commands

### Requirement: Credentialed browse capability
Sunny SHALL provide a browse capability with two modes: a **credentialed** mode that runs in an isolated, persistent browser profile (a local on-disk session/profile, e.g. an `agent-browser` durable session) that retains session/cookie state across runs so the owner logs in once and the session is reused; and a **research** mode that uses an ephemeral, un-credentialed context. The capability SHALL be driven as a CLI (e.g. the `agent-browser` CLI) through the bash tool rather than a dedicated browser tool. The owner's authenticated session state SHALL reside on the local host (not third-party infrastructure) by default. Site logins SHALL be resolved only from the capability's declared `op://` references at fill-time within the automation layer and SHALL NOT be exposed to the model.

#### Scenario: Session persists across runs
- **WHEN** the owner has logged into a site in the credentialed profile
- **THEN** a later run reuses the persisted session without logging in again

#### Scenario: Login filled without exposing the value
- **WHEN** the browse capability authenticates to a site
- **THEN** it resolves the login from a declared `op://` reference and fills it within the automation layer
- **AND** the value is not exposed to the model

#### Scenario: Research browsing uses a disposable context
- **WHEN** Sunny browses an arbitrary page for research
- **THEN** it uses an ephemeral, un-credentialed context that does not touch the owner's persisted sessions

### Requirement: Per-site browse skills use the SKILL.md standard
Per-site browsing knowledge ("how to navigate site X") SHALL be expressed as `agentskills.io` `SKILL.md` skills loaded through the standard skill loader, so that site-learning reuses Sunny's existing skill system rather than a bespoke second format. Such skills MAY be authored by Sunny or installed from an engine-agnostic catalog (e.g. the browse.sh per-site catalog), and SHALL NOT require a browser-engine-specific runtime to be loadable.

#### Scenario: A site skill loads like any other skill
- **WHEN** Sunny needs to operate a specific site it has a skill for
- **THEN** that per-site skill is discovered and loaded through the same SKILL.md loader as any other skill

### Requirement: Capabilities delivered as skills over the thin tools
Higher-level capabilities SHALL be delivered as `SKILL.md` skills composed over the thin tools, including: an **email** skill (read/triage/send over the `himalaya` CLI via bash, for the owner's Sunny mailbox), and a **website-builder** skill (single-page HTML for explainers, presentations, and reports, using design styles bundled in the skill and the `devbox` skill to build/run/host). (Hard-gating of "act as the owner" actions such as sending email is delivered by the `security-permissions` change.)

#### Scenario: Email skill operates over himalaya
- **WHEN** Sunny reads or sends mail for the owner's mailbox
- **THEN** it does so through the email skill running the `himalaya` CLI via bash

#### Scenario: Website-builder produces a styled single-page site
- **WHEN** Sunny is asked to build an explainer, presentation, or report site
- **THEN** the website-builder skill produces a single-page HTML site using a bundled design style and the `devbox` skill to run/host it

