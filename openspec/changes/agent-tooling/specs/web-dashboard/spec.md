## ADDED Requirements

### Requirement: Tools directory on the dashboard
The read-only dashboard SHALL present a Tools directory listing every registered tool with its declared risk tier and declared `op://` credential references. The directory SHALL remain observe-only — it SHALL NOT expose any control to invoke, edit, or configure a tool.

#### Scenario: Tools listed with tier and references
- **WHEN** the owner views the Tools directory
- **THEN** each registered tool is listed with its risk tier and the credential references it declares

#### Scenario: Tools directory is observe-only
- **WHEN** the owner views the Tools directory
- **THEN** no control is presented to invoke, edit, or configure any tool

### Requirement: Skills directory on the dashboard
The read-only dashboard SHALL present a Skills directory listing every installed and self-authored skill with its description, its trust tier (self-authored vs installed), and its source. The directory SHALL remain observe-only — it SHALL NOT expose any control to run, edit, install, or delete a skill.

#### Scenario: Skills listed with description and trust tier
- **WHEN** the owner views the Skills directory
- **THEN** each skill is listed with its description, trust tier, and source

#### Scenario: Skills directory is observe-only
- **WHEN** the owner views the Skills directory
- **THEN** no control is presented to run, edit, install, or delete any skill
