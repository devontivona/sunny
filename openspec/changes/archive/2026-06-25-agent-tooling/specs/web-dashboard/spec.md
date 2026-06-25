## ADDED Requirements

### Requirement: Tools directory on the dashboard
The read-only dashboard SHALL present a Tools directory listing the registered tools, each with its name, a one-line purpose, whether it is owner-only, and its input parameters (name, type, required) — derived from the live tool schema. The directory SHALL remain observe-only — it SHALL NOT expose any control to invoke, edit, or configure a tool.

#### Scenario: Tools listed with purpose, owner-only flag, and parameters
- **WHEN** the owner views the Tools directory
- **THEN** each registered tool is listed with its purpose, owner-only flag, and input parameters

#### Scenario: Tools directory is observe-only
- **WHEN** the owner views the Tools directory
- **THEN** no control is presented to invoke, edit, or configure any tool

### Requirement: Credentials directory on the dashboard
The read-only dashboard SHALL present a Credentials directory (its own page) listing the credential registry: each credential's name → `op://` reference and purpose — references and metadata only, never values. The directory SHALL remain observe-only — it SHALL NOT reveal any secret value, nor expose any control to add, edit, or remove a credential.

#### Scenario: Credentials listed without values
- **WHEN** the owner views the Credentials directory
- **THEN** each registered credential is listed by name with its `op://` reference and purpose, and no secret value is shown

#### Scenario: Credentials directory is observe-only
- **WHEN** the owner views the Credentials directory
- **THEN** no control is presented to add, edit, or remove a credential

### Requirement: Skills directory on the dashboard
The read-only dashboard SHALL present a Skills directory listing every installed and self-authored skill with its description, its trust tier (self-authored vs installed), and its source. Each skill SHALL be openable to a detail view rendering its full `SKILL.md` body and listing the other files in its directory (e.g. `scripts/`, `references/`, `assets/`). The directory SHALL remain observe-only — it SHALL NOT expose any control to run, edit, install, or delete a skill.

#### Scenario: Skills listed with description and trust tier
- **WHEN** the owner views the Skills directory
- **THEN** each skill is listed with its description, trust tier, and source

#### Scenario: Skill detail shows the SKILL.md and its files
- **WHEN** the owner opens a skill
- **THEN** the full `SKILL.md` body is rendered and the other files in the skill's directory are listed

#### Scenario: Skills directory is observe-only
- **WHEN** the owner views the Skills directory
- **THEN** no control is presented to run, edit, install, or delete any skill
