## ADDED Requirements

### Requirement: Tools declare risk tier and allowed credential references
Every tool SHALL register with a risk tier (auto, approval-required, or forbidden-by-default) and the explicit set of `op://` credential references it may resolve (defaulting to none). The runtime SHALL enforce gating from the risk tier and SHALL refuse any credential resolution not in the tool's declared set.

#### Scenario: Risk tier enforced
- **WHEN** a tool classified as approval-required is invoked
- **THEN** the runtime requires user approval before executing it

#### Scenario: Default no credentials
- **WHEN** a tool that declared no credential references attempts to resolve a secret
- **THEN** the resolution is refused

### Requirement: Conservative default tiering
Tools whose risk is unknown, or that perform destructive, irreversible, money-spending, or act-as-the-user operations, SHALL default to approval-required or forbidden, never auto. Read-only and clearly low-consequence tools MAY be auto.

#### Scenario: Unknown tool defaults to gated
- **WHEN** a newly added tool does not clearly qualify as low-consequence
- **THEN** it defaults to approval-required rather than auto

#### Scenario: Act-as-user tools are gated
- **WHEN** a tool sends email or performs a credentialed web action
- **THEN** it is approval-required and hard-gated

### Requirement: Credentialed browser tool routing
The credentialed browser tool SHALL run through the isolated browser profile, SHALL resolve site logins only from its whitelisted references at fill-time within the automation layer, and SHALL treat any credentialed action as approval-required.

#### Scenario: Login filled without exposing the value
- **WHEN** the browser tool authenticates to a site
- **THEN** it resolves the login from its whitelisted reference and fills it in the automation layer
- **AND** the value is not exposed to the model

#### Scenario: Credentialed action gated
- **WHEN** the browser tool performs an action on a logged-in site on the user's behalf
- **THEN** it requires user approval first
