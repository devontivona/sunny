# runtime-home Specification

## Purpose
TBD - created by archiving change restructure-runtime-home. Update Purpose after archive.
## Requirements
### Requirement: Runtime home is a namespace, not a repository
`~/.sunny` SHALL be a plain directory that namespaces Sunny's on-disk artifacts, and SHALL NOT itself be a git repository. Each concern under it SHALL own its own backing model (a git repository, a set of independent clones, or untracked data), so that no git repository's working tree is nested inside another tracked tree.

#### Scenario: Home directory has no repository
- **WHEN** the runtime home is initialized
- **THEN** `~/.sunny` contains no `.git` directory
- **AND** `~/.sunny/state/`, `~/.sunny/skills/`, and `~/.sunny/media/` exist as independent siblings

#### Scenario: No nested working trees
- **WHEN** a git repository (the `state` repo or any skill clone) exists under `~/.sunny`
- **THEN** it is not contained within another git repository's tracked tree
- **AND** no `.gitignore` is required to exclude one repository's working tree from another

### Requirement: Local bootstrap configuration
`~/.sunny/config.json` SHALL be a local, unsynced bootstrap file that names the remotes Sunny clones from — at minimum the `state` repository remote and the canonical skills repository remote. It SHALL be created with defaults on first run and SHALL NOT be tracked by the `state` repository, because it is required before any clone can occur.

#### Scenario: Bootstrap names remotes before cloning
- **WHEN** Sunny starts on a host where `~/.sunny/state` and the skills clones do not yet exist
- **THEN** it reads the state and skills remotes from `~/.sunny/config.json`
- **AND** clones each into place

#### Scenario: Config is not in the state repo
- **WHEN** the `state` repository is inspected
- **THEN** `config.json` is not among its tracked files

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

### Requirement: Skill tiers are siblings of state
`~/.sunny/skills/` SHALL be a sibling of `~/.sunny/state/` containing three location-trusted tiers: `authored/` (a clone of the canonical skills repository, writable and pushed by Sunny), `trusted/<slug>/` (read-only clones of owner-owned repositories), and `installed/` (third-party skills, treated as untrusted). Because these clones are siblings of the `state` repository rather than nested inside it, they SHALL NOT require gitignoring and SHALL each back up via their own remote where one exists.

#### Scenario: Three tiers exist as independent clones
- **WHEN** skills are synced
- **THEN** `authored/`, `trusted/<slug>/`, and `installed/` exist under `~/.sunny/skills/`
- **AND** the `state` repository does not track any of them

#### Scenario: Trust is assigned by location
- **WHEN** a skill is loaded from `installed/`
- **THEN** it is treated as untrusted regardless of how it arrived there

### Requirement: Canonical skills repository uses the spec layout
The canonical skills repository (`authored/`) SHALL package its skills under a top-level `skills/<name>/SKILL.md` directory so that other agents can install it via the standard `npx skills add <owner/repo>` flow. The authored tier's writable root SHALL therefore resolve to `<clone>/skills`, so that self-authored skills are written into, committed to, and pushed from the spec-compliant location.

#### Scenario: External agent can install from the repo
- **WHEN** another agent runs `npx skills add <owner/skills-repo>`
- **THEN** the installer discovers skills under the repository's top-level `skills/` directory

#### Scenario: Authored writes target the nested location
- **WHEN** Sunny authors or edits a skill in the authored tier
- **THEN** the file is written under `<clone>/skills/<name>/SKILL.md`
- **AND** committed and pushed to the canonical repository

### Requirement: Supported skill repository layouts
The skill loader SHALL recognize exactly two clean-layout arrangements for authored and trusted skill repositories: a single-skill repository (a `SKILL.md` at the repository root) and a multi-skill repository (`skills/<name>/SKILL.md`). The loader SHALL NOT recognize skill folders placed directly at the repository root (`<name>/SKILL.md` with no top-level `skills/` parent), as that arrangement is not part of the spec. The separate recursive loader for the `installed/` tier is unaffected.

#### Scenario: Nested and single-skill layouts load
- **WHEN** a repository contains either a root `SKILL.md` or `skills/<name>/SKILL.md` entries
- **THEN** the loader discovers its skills

#### Scenario: Root-level multi-skill layout is not loaded
- **WHEN** a repository places skill folders at its root as `<name>/SKILL.md` with no top-level `skills/` directory
- **THEN** the clean-layout loader does not treat them as skills

### Requirement: Single-source skill git helper and accurate layout documentation
There SHALL be a single source of truth for the logic that persists, commits, and syncs authored skills; any bundled standalone helper (e.g. the skill-authoring script) SHALL be generated from that source and SHALL target the authored tier's writable root. System-prompt and code documentation describing where skills live SHALL accurately reflect the `authored`/`trusted`/`installed` layout.

#### Scenario: Bundled helper matches the loader's layout
- **WHEN** the bundled skill-authoring helper writes a skill
- **THEN** it writes to the same authored root the loader scans
- **AND** does not write outside that root

#### Scenario: Prompt describes the real layout
- **WHEN** the system prompt references skill locations
- **THEN** it names the `authored`/`trusted`/`installed` tiers and not a non-existent flat or `skill-sources/` layout

### Requirement: Migration from the legacy runtime home
Migrating an existing host where `~/.sunny` is itself a git repository SHALL move the tracked state files into `~/.sunny/state/`, relocate the git repository to back the `state` directory, configure the private remote, and push an initial commit, without losing existing memory, credentials, or site content.

#### Scenario: Legacy home is migrated in place
- **WHEN** the migration runs against a `~/.sunny` that is a git repository
- **THEN** existing `memory/`, `credentials.json`, and `sites/` content is relocated under `~/.sunny/state/`
- **AND** the `state` repository is created with the private remote configured
- **AND** an initial commit is pushed

### Requirement: Scratch space for working files
The runtime home SHALL provide `~/.sunny/scratch/` — a machine-local, untracked sibling of `state/` — created at boot, and the agent's prompt SHALL direct temporary/working files (downloads, intermediate outputs, one-off scripts) there. Working files SHALL NOT be written into the runtime-home root or into `state/` (whose history is durable and synced); durable artifacts continue to use their homes (`state/sites`, the authored skills repository, memory).

#### Scenario: Scratch exists on boot
- **WHEN** the runtime starts
- **THEN** `~/.sunny/scratch/` exists and is not inside any git repository's tracked tree

#### Scenario: The agent is taught the convention
- **WHEN** a run holds the host tools
- **THEN** its prompt names `~/.sunny/scratch/` as the place for temporary files and warns against littering `state/`

