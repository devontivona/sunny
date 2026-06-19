## ADDED Requirements

### Requirement: Uniform tool registration contract
Every tool SHALL be registered through a uniform contract that declares, at minimum, its risk tier (auto / approval / forbidden) and the exact `op://` credential references it may resolve (defaulting to none). These declarations SHALL travel with the tool definition so that policy and credential layers can read them uniformly, without a new tool being able to bypass them. In this change the declarations are recorded and surfaced (e.g. on the dashboard) but are NOT yet enforced; enforcement is delivered by the `security-permissions` change, which reads these same declarations.

#### Scenario: Tool declares its tier and credential references
- **WHEN** a tool is registered
- **THEN** it carries a declared risk tier and the set of `op://` references it may resolve (possibly empty)

#### Scenario: Declarations are uniform and machine-readable
- **WHEN** the policy or credential layer inspects a tool
- **THEN** it can read the tool's risk tier and credential references through the same contract for every tool

### Requirement: Core thin tools (bash, file read, web fetch)
Sunny SHALL expose capability primarily through a `bash` tool that executes a command on the host and returns its output, plus thin `file-read` and `web-fetch` tools. Content returned by `web-fetch` (and by `bash` commands that read external content) SHALL be treated as untrusted data.

#### Scenario: Bash runs a command and returns output
- **WHEN** Sunny invokes the bash tool with a command
- **THEN** the command runs on the host and its stdout/stderr and exit status are returned

#### Scenario: Fetched content is untrusted
- **WHEN** the web-fetch tool retrieves a URL
- **THEN** the returned content is handled as untrusted data, not as instructions

### Requirement: Per-command credential injection
Secrets SHALL be injected into the specific command invocation that needs them (resolving `op://` references into that subprocess's environment at execution time, e.g. via `op run`), and SHALL NOT be exposed to the model or placed in the model's context. A command SHALL only receive credential references explicitly permitted for it (or its skill).

#### Scenario: Secret bound to one command only
- **WHEN** a command needs a credential
- **THEN** the value is resolved into that subprocess's environment at run time
- **AND** is not visible to the model or to other commands

### Requirement: Credentialed browse capability
Sunny SHALL provide a browse capability with two modes: a **credentialed** mode that runs in an isolated, persistent browser profile (a local on-disk session/profile, e.g. an `agent-browser` durable session) that retains session/cookie state across runs so the owner logs in once and the session is reused; and a **research** mode that uses an ephemeral, un-credentialed context. The owner's authenticated session state SHALL reside on the local host (not third-party infrastructure) by default. Site logins SHALL be resolved only from the capability's declared `op://` references at fill-time within the automation layer and SHALL NOT be exposed to the model.

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
