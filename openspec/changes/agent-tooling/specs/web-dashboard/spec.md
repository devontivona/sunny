## ADDED Requirements

### Requirement: Tools directory on the dashboard
The read-only dashboard SHALL present a Tools directory listing the registered tools (each with its name, a one-line purpose, and whether it is owner-only) and the credential registry (each credential's name → `op://` reference and purpose — references and metadata only, never values). The directory SHALL remain observe-only — it SHALL NOT expose any control to invoke, edit, or configure a tool, nor reveal any secret value.

#### Scenario: Tools and credentials listed
- **WHEN** the owner views the Tools directory
- **THEN** each registered tool is listed with its purpose and owner-only flag, and each registered credential is listed by name with its `op://` reference (no values)

#### Scenario: Tools directory is observe-only
- **WHEN** the owner views the Tools directory
- **THEN** no control is presented to invoke, edit, or configure any tool, and no secret value is shown

### Requirement: Skills directory on the dashboard
The read-only dashboard SHALL present a Skills directory listing every installed and self-authored skill with its description, its trust tier (self-authored vs installed), and its source. The directory SHALL remain observe-only — it SHALL NOT expose any control to run, edit, install, or delete a skill.

#### Scenario: Skills listed with description and trust tier
- **WHEN** the owner views the Skills directory
- **THEN** each skill is listed with its description, trust tier, and source

#### Scenario: Skills directory is observe-only
- **WHEN** the owner views the Skills directory
- **THEN** no control is presented to run, edit, install, or delete any skill
