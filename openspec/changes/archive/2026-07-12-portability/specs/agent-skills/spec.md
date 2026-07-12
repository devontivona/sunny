# agent-skills Delta Specification

## MODIFIED Requirements

### Requirement: SKILL.md standard, stored as files
Skills SHALL follow the `agentskills.io` `SKILL.md` format — a `skills/<name>/SKILL.md` with YAML frontmatter (at least `name` and `description`) and a markdown body, plus optional `scripts/`, `references/`, and `assets/`. Agent- and owner-authored skills SHALL be stored as plain files in a dedicated git repository the user controls, with `~/.sunny/skills/` as the local working copy. Builtin skills SHALL be stored as plain files in the application repository under `agent/builtin/skills/` and read in place.

#### Scenario: A skill is a standard SKILL.md directory
- **WHEN** a skill exists
- **THEN** it is a directory containing a `SKILL.md` with `name` and `description` frontmatter, stored either in the skill repository (authored/trusted/installed) or in the application repository (builtin)

#### Scenario: Skills are version-controlled
- **WHEN** the skill repository or the application repository is inspected
- **THEN** skills consist of plain files whose git history records every skill change

## REMOVED Requirements

### Requirement: Seeded skill-management and capability skills
**Reason**: Seed materialization (write-if-missing copies of shipped skills into the authored repository) created two sources of truth: the in-code seed rotted while the materialized copy drifted, and runtime-coupled skills (e.g. `delegation` documenting the authority model, `coding` documenting the file tools) went stale on deployed machines whenever the runtime changed. Shipped skills are now the `builtin` class — read in place from the app repo, updated by code deploy.
**Migration**: The runtime-coupled seed skills (`dreaming`, `coding`, `delegation`, `find-skills`, `skill-authoring`) move to `agent/builtin/skills/`; the learned-capability seeds (`email`, `browse`, `website-builder` — each riding a host-installed tool) stop shipping with the app entirely and live solely in the authored skills repository, which already carries their evolved copies. A one-time cleanup removes builtin-name copies previously materialized into the authored repository when they are byte-identical to a shipped seed version (or hand-verified as stale/upstreamed); copies the owner or agent genuinely modified are left in place as intentional forks that shadow their builtins.

## ADDED Requirements

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
