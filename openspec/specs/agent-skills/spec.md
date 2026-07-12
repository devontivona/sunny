# agent-skills Specification

## Purpose
TBD - created by syncing change agent-tooling. Update Purpose after archive.
## Requirements
### Requirement: SKILL.md standard, stored as files
Skills SHALL follow the `agentskills.io` `SKILL.md` format — a `skills/<name>/SKILL.md` with YAML frontmatter (at least `name` and `description`) and a markdown body, plus optional `scripts/`, `references/`, and `assets/`. Agent- and owner-authored skills SHALL be stored as plain files in a dedicated git repository the user controls, with `~/.sunny/skills/` as the local working copy. Builtin skills SHALL be stored as plain files in the application repository under `agent/builtin/skills/` and read in place.

#### Scenario: A skill is a standard SKILL.md directory
- **WHEN** a skill exists
- **THEN** it is a directory containing a `SKILL.md` with `name` and `description` frontmatter, stored either in the skill repository (authored/trusted/installed) or in the application repository (builtin)

#### Scenario: Skills are version-controlled
- **WHEN** the skill repository or the application repository is inspected
- **THEN** skills consist of plain files whose git history records every skill change

### Requirement: Unified skill store and install path
Self-authored and externally found skills SHALL share one workflow: both live in the dedicated skill repository and are installed/updated through the same `npx skills` path (`npx skills add owner/repo`). A self-authored skill SHALL be committed to the repository and become installable by that same path; an external skill MAY be vendored into the repository. Sunny committing to the repository SHALL use a declared credential reference for git authentication.

#### Scenario: Self-authored and found skills use one install path
- **WHEN** Sunny authors a skill or installs an external one
- **THEN** both are recorded in the skill repository and installed through the same `npx skills` workflow

#### Scenario: Commit uses a declared credential
- **WHEN** Sunny commits a skill to the repository
- **THEN** git authentication uses a declared credential reference, not a value exposed to the model

### Requirement: Progressive-disclosure loading
Only skill metadata (`name` + `description`) SHALL be loaded into context by default; a skill's body SHALL be loaded only when a task matches, and its `references`/`scripts` only when needed. Script code SHALL NOT be loaded into context (only its output). The metadata index SHALL be budget-capped, dropping least-used descriptions first while retaining names.

#### Scenario: Body loaded on match
- **WHEN** a task matches a skill's description
- **THEN** Sunny loads that skill's body
- **AND** skills not matched have only their metadata in context

#### Scenario: Index respects a budget
- **WHEN** the number of skills would exceed the metadata budget
- **THEN** least-used skill descriptions are dropped from the always-on index first, with names retained

### Requirement: Self-authoring with notification
Sunny SHALL be able to create, edit, and delete its own skills. A self-authored skill SHALL be created automatically (without requiring approval), the user SHALL be notified that it was created, and it SHALL be immediately usable. The user SHALL be able to review, edit, or delete the skill file at any time.

#### Scenario: Sunny writes a skill and notifies
- **WHEN** Sunny completes a reusable workflow worth capturing
- **THEN** it writes a `SKILL.md` for it, the skill becomes usable, and the user is notified it was created

#### Scenario: User can remove a self-authored skill
- **WHEN** the user deletes or edits a self-authored skill file
- **THEN** the change takes effect on the next run

### Requirement: Installed skills are untrusted and gated
Installing a skill from an external source (e.g. a registry or git repo) SHALL be treated as introducing untrusted code: the installation SHALL require user approval and SHALL be reviewable before the skill is enabled. (The approval mechanism itself is delivered by the `security-permissions` change; this change establishes the trust-tier distinction and the install path.)

#### Scenario: External install requires approval
- **WHEN** Sunny attempts to install a skill from an external source
- **THEN** it requires user approval before the skill is installed/enabled

#### Scenario: Self-authored vs installed distinction
- **WHEN** a skill is created by Sunny itself
- **THEN** it follows the auto-and-notify path, not the approval-gated install path

### Requirement: Skills cannot escalate privilege
When a skill runs scripts or invokes tools, those actions SHALL pass through the same tool-access gating, approval tiers, and hard blocklist as any other tool use. A skill's `allowed-tools` declaration MAY further restrict but SHALL NOT expand what it can do. (The gating/approval/blocklist enforcement is delivered by the `security-permissions` change; this change ensures skill actions route through the same tool surface so that enforcement applies uniformly once present.)

#### Scenario: Skill action still gated
- **WHEN** a skill's instructions or scripts attempt a high-consequence action
- **THEN** that action is subject to the normal approval/blocklist gating

#### Scenario: allowed-tools only restricts
- **WHEN** a skill declares `allowed-tools`
- **THEN** the skill is limited to that subset and cannot gain access to tools outside it

### Requirement: Validation before activation
A skill SHALL be validated against the `SKILL.md` schema when created or installed, and an invalid skill SHALL NOT be activated.

#### Scenario: Invalid skill rejected
- **WHEN** a created or installed skill fails schema validation
- **THEN** it is not activated

### Requirement: Skill index may be filtered by run authority
The skill index presented to a run MAY be filtered to the skills that run can actually act on given its endowed authority, so a run is not offered a skill whose required tools it was not granted. Filtering SHALL only ever narrow the index; it SHALL NOT grant access to a skill outside the run's authority.

#### Scenario: A memory-only run is not shown host-requiring skills
- **WHEN** a run endowed only memory grants loads the skill index
- **THEN** skills that require host tools (e.g. a site builder needing shell) are omitted from its index

#### Scenario: Filtering never expands access
- **WHEN** the skill index is filtered for a run
- **THEN** no skill outside the run's authority becomes usable as a result

### Requirement: Builtin skill class
Sunny SHALL ship a `builtin` skill class: skills stored in the application repository under `agent/builtin/skills/<name>/`, read in place at runtime, trusted by location, and never materialized into `~/.sunny` or the authored skills repository. Builtin skills SHALL be read-only at runtime — the skill write boundary SHALL reject agent edits to builtin skills exactly as it does for `trusted/` clones. A skill SHALL ship builtin only when it depends solely on surfaces that ship with Sunny — the native tool surface, the repo's own CLI, or the skill system itself; a capability that rides a host-installed, owner-configured tool (e.g. himalaya, agent-browser, devbox) SHALL live in the authored skills repository instead, so the skill travels with the tool setup it needs. The shipped set SHALL cover at least: skill authoring, skill discovery/installation, delegation & scheduling, coding, and dreaming (recurring memory maintenance).

#### Scenario: Builtin skills track the deployed runtime
- **WHEN** the runtime's tool surface changes (e.g. the authority model or file tools) and the code is redeployed
- **THEN** the builtin skills documenting that surface are already updated in the same deploy, with no per-machine re-seed

#### Scenario: Agent cannot edit a builtin skill
- **WHEN** Sunny attempts to write to a builtin skill's files
- **THEN** the write boundary rejects the edit and directs it to fork the skill into `authored/` instead

#### Scenario: Builtins never enter the authored repository
- **WHEN** the authored skills repository is inspected after any number of boots
- **THEN** it contains no automatically materialized copies of builtin skills

### Requirement: Authored skills shadow builtins
An authored skill with the same name as a builtin SHALL take precedence (shadow the builtin) — this is the customization path: fork the builtin into `authored/`, then edit. The skill index SHALL present exactly one entry for a shadowed name and SHALL annotate it as shadowing a builtin, so stale forks are visible when the underlying builtin changes.

#### Scenario: Fork-to-customize
- **WHEN** an authored skill exists with the same name as a builtin
- **THEN** the authored version is the one loaded, and the index annotates it as shadowing a builtin

#### Scenario: Deleting the fork restores the builtin
- **WHEN** the owner deletes an authored skill that was shadowing a builtin
- **THEN** the builtin version is served again on the next index render
