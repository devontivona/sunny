# runtime-home Delta Specification

## MODIFIED Requirements

### Requirement: State repository with private-remote backup
`~/.sunny/state/` SHALL be a git repository tracking Sunny's durable, portable state — at minimum `memory/` (core files and `topics/`), `credentials.json` (symbolic `op://` references only, never secret values), `sites/`, `schedules/` (standing schedule files — the agent's portable recurring intents), and `mcp.json` (the MCP server registry: URLs, names, purposes, and auth REFERENCES only — OAuth tokens remain machine-local outside the repository). It SHALL be configured with an owner-controlled private remote and SHALL maintain a clean working tree (no untracked-and-unignored state files).

#### Scenario: State tracks memory, credentials, sites, standing schedules, and the MCP registry
- **WHEN** the `state` repository is initialized
- **THEN** `memory/`, `credentials.json`, `sites/`, `schedules/`, and `mcp.json` are tracked
- **AND** the working tree is clean after each state write

#### Scenario: No secret values are stored
- **WHEN** `credentials.json` or `mcp.json` is written
- **THEN** it contains only symbolic names/references (`op://` references, credential names)
- **AND** no resolved secret value or OAuth token is present

#### Scenario: MCP registry restores on a fresh host
- **WHEN** a fresh host clones the state repository
- **THEN** the registered MCP servers are present (disabled auth flows re-authorize per machine)

#### Scenario: Legacy machine-local registry migrates
- **WHEN** a host still has a pre-portability `~/.sunny/mcp.json`
- **THEN** it is relocated into the state repository on first read, contents intact

### Requirement: Commit-on-write state persistence
State writes (memory edits, credential registry updates, MCP registry updates, standing-schedule creation/deletion) SHALL be committed to the `state` repository immediately after each write via a single shared helper, so the repository's history reflects every change. Pushing to the remote SHALL be best-effort and MAY be batched on a periodic cadence rather than performed synchronously per write; a failed push SHALL be non-fatal and SHALL leave the change committed locally.

#### Scenario: Every state write is committed
- **WHEN** a memory file, the credential registry, or the MCP registry is written
- **THEN** the shared helper commits the change to the `state` repository

#### Scenario: Push failure is non-fatal
- **WHEN** the periodic push to the private remote fails (e.g. offline)
- **THEN** the change remains committed locally and the operation does not error
- **AND** a subsequent successful push includes the pending commits

## ADDED Requirements

### Requirement: Scratch space for working files
The runtime home SHALL provide `~/.sunny/scratch/` — a machine-local, untracked sibling of `state/` — created at boot, and the agent's prompt SHALL direct temporary/working files (downloads, intermediate outputs, one-off scripts) there. Working files SHALL NOT be written into the runtime-home root or into `state/` (whose history is durable and synced); durable artifacts continue to use their homes (`state/sites`, the authored skills repository, memory).

#### Scenario: Scratch exists on boot
- **WHEN** the runtime starts
- **THEN** `~/.sunny/scratch/` exists and is not inside any git repository's tracked tree

#### Scenario: The agent is taught the convention
- **WHEN** a run holds the host tools
- **THEN** its prompt names `~/.sunny/scratch/` as the place for temporary files and warns against littering `state/`
