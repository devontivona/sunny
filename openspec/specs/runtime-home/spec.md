# runtime-home Specification

## Purpose
TBD - created by archiving change restructure-runtime-home. Update Purpose after archive.
## Requirements
### Requirement: Runtime home is a namespace, not a repository
`~/.sunny` SHALL be a plain directory that namespaces Sunny's on-disk artifacts, and SHALL NOT itself be a git repository. Each concern under it SHALL own its own backing model (a git repository, a set of independent clones, or untracked data), so that no git repository's working tree is nested inside another tracked tree.

#### Scenario: Home directory has no repository
- **WHEN** the runtime home is initialized
- **THEN** `~/.sunny` contains no `.git` directory
- **AND** `~/.sunny/state/`, `~/.sunny/data/`, `~/.sunny/skills/`, `~/.sunny/scratch/`, and `~/.sunny/media/` exist as independent siblings

#### Scenario: No nested working trees
- **WHEN** a git repository (the `state` repo, the `data` repo, or any skill clone) exists under `~/.sunny`
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
`~/.sunny/state/` SHALL be a git repository tracking exactly Sunny's code-written durable record — `memory/` (core files and `topics/`), `credentials.json` (symbolic `op://` references only, never secret values), `schedules/` (standing schedule files — the agent's portable recurring intents), and `mcp.json` (the MCP server registry: URLs, names, purposes, and auth REFERENCES only — OAuth tokens remain machine-local outside the repository). Agent-authored artifacts (sites, projects, working state) SHALL live in `~/.sunny/data/` instead. The state repository SHALL be configured with an owner-controlled private remote and SHALL maintain a clean working tree (no untracked-and-unignored state files).

#### Scenario: State tracks memory, credentials, standing schedules, and the MCP registry
- **WHEN** the `state` repository is initialized
- **THEN** `memory/`, `credentials.json`, `schedules/`, and `mcp.json` are tracked
- **AND** no `sites/` directory is present (sites live in the data repository)
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
The runtime home SHALL provide `~/.sunny/scratch/` — a machine-local, untracked sibling of `state/` — created at boot and garbage-collected: at boot and on a daily cadence, top-level entries whose age (mtime; for directories, the newest mtime within) exceeds a configurable threshold (default 14 days) SHALL be deleted. The agent's prompt SHALL teach the three-domain convention on every surface that holds the file/bash tools — interactive turns and durable jobs alike: temporary/working files (downloads, intermediate outputs, one-off scripts) → `scratch/` (may vanish); durable agent-authored artifacts → `data/` (sites → `data/sites`, projects → `data/projects`); `state/` is never written by the agent (the file tools refuse it); facts → memory; procedures → skills.

#### Scenario: Scratch exists on boot
- **WHEN** the runtime starts
- **THEN** `~/.sunny/scratch/` exists and is not inside any git repository's tracked tree

#### Scenario: Old scratch entries are collected
- **WHEN** a top-level scratch entry's age exceeds the threshold at boot or the daily tick
- **THEN** it is deleted
- **AND** entries newer than the threshold are untouched

#### Scenario: The agent is taught the convention on every tool-holding surface
- **WHEN** any run holds the file/bash tools — an interactive conversation turn or a durable job
- **THEN** its prompt names `scratch/` for temporary files, `data/` for durable artifacts, and states that `state/` is code-managed and refused by the file tools

### Requirement: Data repository for agent-authored durable artifacts
`~/.sunny/data/` SHALL be a git repository, a sibling of `state/`, holding durable artifacts the agent authors with its own tools — at minimum `sites/` (built websites) and `projects/` (code projects), plus any structured working state (ledgers, indexes) a skill needs to keep across runs. It SHALL be the sanctioned home for every durable agent-written file that is not a memory fact (→ memory) or a procedure (→ the authored skills repository). Its remote SHALL be named in `~/.sunny/config.json` and SHALL be optional: when unset, the repository exists locally and pushing is a no-op. The agent SHALL NOT be required to run git here — persistence is the runtime's job.

#### Scenario: Data directory exists on boot as its own repository
- **WHEN** the runtime starts
- **THEN** `~/.sunny/data/` exists as a git repository that is a sibling of `state/`, not nested in any tracked tree

#### Scenario: No remote configured is not an error
- **WHEN** `config.json` names no data remote
- **THEN** the data repository operates locally and push attempts are silent no-ops

### Requirement: Data repository sweep persistence
The runtime SHALL persist the data repository by sweep: on the existing periodic push cadence and once at boot, it SHALL commit all outstanding changes in `~/.sunny/data/` (message `data: sweep`) and push best-effort to the configured remote. A failed push SHALL be non-fatal and SHALL leave commits local for the next attempt.

#### Scenario: Agent writes are committed within one sweep interval
- **WHEN** the agent writes a file under `~/.sunny/data/` and the next sweep tick fires
- **THEN** the change is committed to the data repository with the sweep message

#### Scenario: Boot sweep catches strandings
- **WHEN** the runtime starts with uncommitted changes in the data repository (e.g. after a crash)
- **THEN** they are committed before normal operation continues

### Requirement: State repository accepts writes only from deterministic code
The `state` repository SHALL be written only by the runtime's own code paths (memory, credential registry, MCP registry, standing schedules) through the shared commit helper. The agent-facing file mutation tools SHALL refuse paths under `~/.sunny/state/` (per the tool-access spec), and the runtime SHALL surface — not silently absorb — foreign changes: when the commit helper or a boot-time check finds tree changes outside what code just wrote, it SHALL log a warning naming the stray paths before committing them.

#### Scenario: Stray files are surfaced, not laundered
- **WHEN** the state working tree contains files the current code write did not produce (e.g. dropped there via bash)
- **THEN** a warning naming those paths is logged
- **AND** the changes are still committed (data is never dropped)

#### Scenario: Dirty tree at boot is reported
- **WHEN** the runtime starts and the state working tree is not clean
- **THEN** a warning naming the dirty paths is logged before the tree is reconciled

### Requirement: Migration relocates agent artifacts into the data repository
Migration SHALL be idempotent and boot-time, and SHALL apply a reserved-set rule: every top-level entry of `state/` that is not `memory/`, `credentials.json`, `schedules/`, `mcp.json`, or git plumbing SHALL be moved into `~/.sunny/data/` — tracked or untracked alike. Migration SHALL also relocate a legacy `~/.sunny/sites/` directory (the pre-runtime-home path that stale skill guidance kept populating) into `~/.sunny/data/sites/`, merging with any sites moved from `state/sites/`. On slug collision the more recently modified copy (newest content mtime) SHALL win in the working tree, and the older copy SHALL be committed to the data repository's history before being overwritten, so no content is lost. The removal SHALL be committed in the state repository and the arrival committed in the data repository, both pushed best-effort.

#### Scenario: Sites and stray entries relocate
- **WHEN** migration runs against a state repository containing `sites/` and non-reserved entries (ad-hoc directories, stray root files)
- **THEN** all of them move under `~/.sunny/data/` with content intact
- **AND** the state repository records their removal in a dedicated migration commit
- **AND** re-running the migration is a no-op

#### Scenario: Legacy root-level sites relocate and merge
- **WHEN** migration runs on a host that also has a legacy `~/.sunny/sites/` directory
- **THEN** its sites move into `~/.sunny/data/sites/` alongside those from `state/sites/`

#### Scenario: Slug collision resolves to the more recent copy without data loss
- **WHEN** the same site slug exists in both `state/sites/` and legacy `~/.sunny/sites/`
- **THEN** the copy with the newest content mtime ends up at `data/sites/<slug>/` in the working tree
- **AND** the older copy is present in the data repository's git history
