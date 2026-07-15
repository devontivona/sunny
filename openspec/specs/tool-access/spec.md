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
host and returns its output, plus thin file primitives: `file-read`, `file-write`, and
`file-edit`. The thin-tool surface SHALL be kept minimal; higher capabilities (browsing,
fetching web pages, email, building sites) SHALL be CLIs driven via bash or `SKILL.md` skills
over bash, NOT dedicated tools — file mutation primitives are part of the minimal surface
itself, not a capability. Web fetching SHALL be performed via bash (e.g. a fetch CLI) or the
browse capability rather than a dedicated `web-fetch` tool. **The one bounded exception is
MCP:** tools fetched from an owner-registered MCP server SHALL be injected into the agent loop
as native tools (an MCP server exposes structured tools with no CLI to shell out to — the
server is the interface), and this exception SHALL apply only to owner-registered MCP servers,
not to any other capability. Any external content entering Sunny's context (fetched pages,
command output that reads remote data, **and MCP tool results**) SHALL be treated as untrusted
data.

The file primitives SHALL behave as follows:

- `file-read` SHALL support line-windowed reading (a 1-based line offset and a line-count
  limit) and SHALL return line-numbered output, with truncation notes that state how to
  continue reading. Binary (non-UTF-8) content SHALL be refused, not decoded.
- `file-write` SHALL create or overwrite a UTF-8 text file, creating missing parent
  directories.
- `file-edit` SHALL replace an exact string in an existing file and SHALL fail — with an
  error the model can recover from — when the target string matches zero times, or matches
  more than once without an explicit replace-all flag. Editing binary content SHALL be
  refused.
- `file-write` and `file-edit` SHALL refuse any target that resolves inside `~/.sunny/state/`
  (the code-managed state repository), with a recoverable error that names `~/.sunny/data/`
  as the home for durable files and `~/.sunny/scratch/` for temporary ones. Resolution SHALL
  be symlink- and `..`-safe (judged against the real path of the deepest existing ancestor),
  and `file-read` SHALL remain unrestricted.
- The file mutation tools SHALL be registered on exactly the surfaces that hold `bash` (the
  same trust gate); they SHALL NOT widen any run's privilege beyond what its bash access
  already grants.

#### Scenario: Bash runs a command and returns output
- **WHEN** Sunny invokes the bash tool with a command
- **THEN** the command runs on the host and its stdout/stderr and exit status are returned

#### Scenario: Windowed, numbered file read
- **WHEN** Sunny reads a file with a line offset and limit
- **THEN** it receives that window of lines, line-numbered, with a note stating how to continue if the file has more lines

#### Scenario: Surgical edit requires a unique match
- **WHEN** Sunny invokes file-edit with a string that occurs more than once (without replace-all) or not at all
- **THEN** the edit is refused with an error stating the match count, and the file is unchanged

#### Scenario: File write creates the file and its directories
- **WHEN** Sunny writes a file whose parent directory does not exist
- **THEN** the directories are created and the file is written with exactly the given content

#### Scenario: Writes into the state repository are refused with redirection
- **WHEN** Sunny invokes file-write or file-edit on a path that resolves inside `~/.sunny/state/` (including via symlink or `..` traversal)
- **THEN** the call fails with a recoverable error naming `~/.sunny/data/` (durable) and `~/.sunny/scratch/` (temporary) as the correct homes
- **AND** the file is unchanged
- **AND** file-read of the same path still succeeds

#### Scenario: File tools ride the bash trust gate
- **WHEN** a run does not have the bash tool (e.g. a readonly or tool-less child)
- **THEN** it has neither file-write nor file-edit

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

### Requirement: Spawn tools endow attenuated authority through one preset vocabulary
The run-creation tools (`delegate_task`, `schedule_create`) SHALL remain distinct verbs but SHALL share ONE model-facing authority vocabulary: the `toolset` presets (`host` — the default; `readonly` — reads only), each naming a fixed grant bundle, attenuated by intersection with the creator's authority; a scheduled or delegated run never holds the `schedule` or `delegate` grants. **`schedule_create` SHALL additionally expose the audience axis as a `deliver_to` parameter**: a roster name (default: the current subject) routing the fired run's reports to that person's conversation loop, or `nobody` for artifact-producing jobs whose outcomes are inspectable in run history only. The former `for` parameter survives as a deprecated alias of `deliver_to` (a non-strict schema would otherwise silently STRIP the old key from a model imitating recorded history, misrouting the schedule with a success confirmation). The tool's description SHALL teach the report model (a fired run reports to a conversation loop, which relays with context — it does not text anyone directly) and the decision rule: artifact-producing job → `nobody`; message-producing job → a person, with a conditionally-reporting prompt ("report only if X; otherwise reply exactly `<no-report/>`"), never an unconditional "report what was processed". Grants cover only what a run may DO (the authority axis); how a run SPEAKS derives from its audience.

#### Scenario: One vocabulary across spawn verbs
- **WHEN** Sunny delegates a subtask or creates a schedule
- **THEN** both verbs accept the same `toolset` presets with the same default (`host`) and the same attenuation semantics

#### Scenario: A silent pipeline schedule is expressible
- **WHEN** Sunny creates a schedule for a job whose product is an artifact (files, a feed, DB state)
- **THEN** it can pass `deliver_to: nobody`, and the fired runs record outcomes without waking any conversation

#### Scenario: Scheduling for a person routes reports to their loop
- **WHEN** Sunny creates a schedule with `deliver_to: Kate`
- **THEN** the fired run's reports land on Kate's conversation thread and the mediating turn frames its relay for Kate

#### Scenario: A fired schedule acts with its stored authority
- **WHEN** a schedule endowed host grants (e.g. `bash`, `file_read`, `mcp`) fires
- **THEN** the fired run holds exactly those grants' tool bundles, and never the spawn verbs

### Requirement: Messaging tools — one reply lane, one addressed verb, derived from the audience
Outward messaging SHALL be exposed as one reply/report lane and one addressed tool, both delivering through the single delivery bus, and their availability SHALL derive from the run's AUDIENCE (masked by trust), never from an authority grant. The lane is the run's own TEXT: for a conversational turn (a **speaker**) the text a turn ends on IS the reply, gateway-delivered to the thread's human; for every autonomous run (a **reporter**) the text a run ends on IS its report, appended to its audience's conversation loop (or its parent's inbox) and mediated by a conversational turn — an autonomous run SHALL NOT gateway-send its lane text. The one addressed `message(recipient, text)` tool sends to a named other entity (roster ∪ the run's currently-running subagents); a person recipient is resolved in the tool (roster-only, model-facing refusals, self-send guard) and the send itself SHALL ride the bus as deliberate chat speech to the resolved DM (`deliver(chat(byThread))`, persisted). Held by: live-thread conversation turns when trusted (never groups); every scheduled run (a delivering run is refused its own subject — its report already reaches them); a subagent (agent audience of its parent's thread) SHALL NOT hold it. `send_image` SHALL be held only by conversational turns: an autonomous run that produces media references the file in its report, and the mediating turn sends it. Arbitrary (non-roster, non-subagent) recipients SHALL be refused.

#### Scenario: Reply needs no address
- **WHEN** a conversational turn replies to whoever it is currently serving
- **THEN** its reply text is delivered with no recipient argument, resolved from the run's Audience

#### Scenario: A reporter's lane text never reaches the gateway directly
- **WHEN** any autonomous run ends on its report text
- **THEN** the text is appended to its audience's conversation loop (or parent inbox) for mediation, and no gateway send occurs from that run

#### Scenario: One addressed verb reaches a person or a subagent
- **WHEN** Sunny relays to a roster member, or steers one of its running subagents
- **THEN** it calls the same `message(recipient, text)` tool, and the bus delivers to that entity's mailbox

#### Scenario: Media flows through the mediating turn
- **WHEN** a scheduled run produces an image or file the user should see
- **THEN** its report carries the file path, and the mediating conversational turn delivers it via its own `send_image`

#### Scenario: Non-roster recipient refused
- **WHEN** `message` is called with a recipient that is neither a roster member nor one of the run's subagents
- **THEN** it is refused

### Requirement: Unified run inspection and cancellation
Sunny SHALL expose `list_runs` and `cancel_run` tools spanning schedules and delegated subagents, scoped by ownership: a caller SHALL see and cancel runs whose derived subject is themselves, and the owner SHALL see and cancel all runs. These SHALL replace schedule-specific list/delete as the general lifecycle surface.

#### Scenario: List spans schedules and subagents
- **WHEN** Sunny lists runs on behalf of a subject
- **THEN** the result includes that subject's schedules and running subagents

#### Scenario: Non-owner cannot cancel another subject's run
- **WHEN** a family member attempts to cancel a run whose subject is someone else
- **THEN** it is refused, while the owner may cancel any run

### Requirement: Callback-hosting tool is trusted-DM-only
The `oauth_callback` tool (per the `callback-hosting` capability) SHALL be exposed only in trusted owner-DM contexts, alongside `bash`, `credentials`, and `mcp_manage` — never in group threads or to non-owner senders — because it mints live public endpoints on Sunny's domain and its captured parameters flow back into the thread. The tool SHALL be registered in the conversation `buildTools()` wiring and mirrored in the read-only dashboard tool catalog, keeping the two in sync.

#### Scenario: Not available outside the owner DM
- **WHEN** a turn runs for a group thread or a non-owner sender
- **THEN** `oauth_callback` is absent from the tool surface

#### Scenario: Catalog parity
- **WHEN** the dashboard renders the tool catalog
- **THEN** `oauth_callback` appears with the same spec (description, schema) the live wiring uses

