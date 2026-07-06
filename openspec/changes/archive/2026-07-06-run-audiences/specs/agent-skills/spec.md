## MODIFIED Requirements

### Requirement: Seeded skill-management and capability skills
Sunny SHALL ship with a set of seeded known-good skills so it can extend itself from day one, including: a skill-authoring skill, a skill-discovery/installation skill, the `devbox` skill, and a single **delegation & scheduling** skill covering the whole spawn taxonomy — when to spawn a run now (background job) vs. delegate to a subagent vs. schedule for later, how to choose the audience (person / household / thread / parent), how to brief completely, and how to endow least authority. This unified skill SHALL replace separate per-tool skills so the (single) judgment of how to spawn work is taught in one place. Seeded skills SHALL be installable through the same install path as any other skill.

#### Scenario: Skill-authoring and discovery skills are present
- **WHEN** Sunny needs to author a new skill or find an existing one
- **THEN** a seeded skill-authoring skill and a seeded skill-discovery/installation skill are available to guide it

#### Scenario: One skill covers the spawn taxonomy
- **WHEN** Sunny must decide between a background job, a subagent, or a schedule
- **THEN** a single seeded delegation & scheduling skill guides the choice of timing, audience, and least authority

#### Scenario: Seeded skills use the standard install path
- **WHEN** a seeded skill is installed
- **THEN** it is installed through the same `SKILL.md` install path as any other skill

## ADDED Requirements

### Requirement: Skill index may be filtered by run authority
The skill index presented to a run MAY be filtered to the skills that run can actually act on given its endowed authority, so a run is not offered a skill whose required tools it was not granted. Filtering SHALL only ever narrow the index; it SHALL NOT grant access to a skill outside the run's authority.

#### Scenario: A memory-only run is not shown host-requiring skills
- **WHEN** a run endowed only memory grants loads the skill index
- **THEN** skills that require host tools (e.g. a site builder needing shell) are omitted from its index

#### Scenario: Filtering never expands access
- **WHEN** the skill index is filtered for a run
- **THEN** no skill outside the run's authority becomes usable as a result
