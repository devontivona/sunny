# agent-skills — delta (coding-agent-upgrade)

## MODIFIED Requirements

### Requirement: Seeded skill-management and capability skills
Sunny SHALL ship with a set of seeded known-good skills so it can extend itself from day one,
including: a skill-authoring skill (how to write a good `SKILL.md`, e.g. from
`anthropics/skills`), a skill-discovery/installation skill (how to find and install skills via
`npx skills` and related installers), the `devbox` skill (build/run/host), and a **coding**
skill (the coding workflow over the thin tools and host CLIs: orient on the target repo's
agent/readme docs first, search with `rg`, read before editing, prefer the file-edit/file-write
tools over shell heredocs, verify changes with the project's tests/typecheck, git hygiene,
backgrounding long-running processes around the bash timeout, serving via devbox, and
channel-appropriate reporting of results). Seeded skills SHALL be installable through the same
install path as any other skill.

#### Scenario: Skill-authoring and discovery skills are present
- **WHEN** Sunny needs to author a new skill or find an existing one
- **THEN** a seeded skill-authoring skill and a seeded skill-discovery/installation skill are available to guide it

#### Scenario: Coding skill guides coding tasks
- **WHEN** Sunny takes on a coding task (editing a repo, building or fixing software)
- **THEN** a seeded coding skill is available describing the search → read → edit → verify → report workflow over the thin tools

#### Scenario: Seeded skills use the standard install path
- **WHEN** a seeded skill is installed
- **THEN** it is installed through the same `SKILL.md` install path as any other skill
