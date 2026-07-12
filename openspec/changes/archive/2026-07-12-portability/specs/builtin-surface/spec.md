# builtin-surface Delta Specification

## ADDED Requirements

### Requirement: Git-committed authored surface split by mechanism
The project repository SHALL contain a top-level `agent/` directory holding all developer-authored runtime artifacts, organized by seeding mechanism: `agent/builtin/` for developer-owned artifacts that remain authoritative for their lifetime, and `agent/seeds/` for templates whose ownership transfers to the runtime after first materialization. No developer-authored skill, schedule, memory starter, or default-config content SHALL remain embedded as string literals in TypeScript source.

#### Scenario: Layout is discoverable by a human
- **WHEN** a developer inspects the repository
- **THEN** builtin skills are at `agent/builtin/skills/<name>/SKILL.md` (with optional `scripts/`, `references/`, `assets/`), builtin schedules at `agent/builtin/schedules/<name>.md`, memory starters at `agent/seeds/memory/*.md`, and the default runtime config at `agent/seeds/config.json`

#### Scenario: No inline authored content in code
- **WHEN** the source tree is searched for the former seed mechanisms
- **THEN** `src/skills/seeds.ts`, `src/skills/seed-assets/`, the `starter*` memory constants, and the `DEFAULT_CONFIG_JSON` literal no longer exist; their content lives under `agent/`

### Requirement: Builtin artifacts are read in place and authoritative
Artifacts under `agent/builtin/` SHALL be read directly from the repository working directory at runtime and SHALL NOT be copied, materialized, or synced into `~/.sunny` or any agent-writable repository. A code deploy SHALL therefore be the sole and sufficient update channel: after a deploy, the running system reflects the deployed builtin content with no reconciliation step.

#### Scenario: Builtin content updates with the code
- **WHEN** a builtin artifact's file is changed and the service is redeployed/restarted
- **THEN** the runtime immediately serves the new content, with no per-machine migration or re-seed

#### Scenario: Builtins are resolved relative to the working directory
- **WHEN** the service runs from the production build (`.output`) with cwd at the repository root
- **THEN** `agent/` resolves correctly via cwd-relative paths, the same pattern used for `drizzle/` migrations

### Requirement: Seed artifacts materialize write-if-missing exactly once
Artifacts under `agent/seeds/` SHALL be materialized into their runtime destinations only when the destination is absent, and SHALL never overwrite an existing destination. After materialization, the runtime copy is owned by the agent/owner and the repo file serves only future fresh installs.

#### Scenario: Fresh install materializes seeds
- **WHEN** the runtime boots on a machine where `~/.sunny/state/memory/USER.md` (or `SUNNY.md`, `INDEX.md`, `~/.sunny/config.json`) does not exist
- **THEN** the corresponding file under `agent/seeds/` is copied into place

#### Scenario: Existing runtime state is never clobbered
- **WHEN** the runtime boots on a machine where a seed's destination already exists (however much it has diverged)
- **THEN** the destination is left untouched, even if the repo seed file has since changed

### Requirement: Builtin content is machine-agnostic
Builtin artifacts SHALL NOT embed machine-specific values — absolute filesystem paths, hostnames, usernames, or personal domains. Where builtin content needs the repository root (e.g. CLI invocations in the dreaming skill), it SHALL reference it as `$SUNNY_REPO`: the agent's bash tool SHALL export `SUNNY_REPO` (= the service working directory) into subprocess environments, and the file tools SHALL expand a leading `$SUNNY_REPO/` in paths. Builtin files are read byte-verbatim (no substitution layer), keeping the rendered prompt both byte-stable for caching and machine-independent.

#### Scenario: Dreaming works from any clone path
- **WHEN** the repo is cloned to a path other than `/home/tivona/projects/sunny` and the dreaming schedule fires
- **THEN** the dreaming skill's CLI invocations resolve `$SUNNY_REPO` to the actual repository root and succeed

#### Scenario: No machine-specific literals in builtins
- **WHEN** `agent/builtin/` is searched for absolute paths, usernames, or personal hostnames
- **THEN** none are found (repo-root references use `$SUNNY_REPO`)
