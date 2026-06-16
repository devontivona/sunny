## ADDED Requirements

### Requirement: Dedicated minimal vault with read-only scoped access
Sunny SHALL access secrets only through a 1Password Service Account scoped to a dedicated `Sunny` vault that contains only the items Sunny needs, using read-only (`read_items`) permission. Sunny SHALL NOT have access to any vault outside the dedicated vault.

#### Scenario: Only the dedicated vault is reachable
- **WHEN** Sunny attempts to resolve a secret
- **THEN** it can resolve items only from the dedicated `Sunny` vault
- **AND** items in the user's other vaults are unreadable

#### Scenario: Read-only access
- **WHEN** Sunny accesses the dedicated vault
- **THEN** it can read items but cannot write or delete them

### Requirement: The model never receives secret values
Sunny's reasoning model SHALL only ever handle `op://` references or symbolic credential names, never resolved secret values. Secret values SHALL be resolved in the tool-execution layer at the point of use and SHALL NOT appear in prompts, tool arguments, model responses, or logs.

#### Scenario: Value resolved outside the model
- **WHEN** a tool needs a secret
- **THEN** the value is resolved by the SDK in the tool layer and injected into the request
- **AND** the value is never placed into model-visible text or logs

#### Scenario: Model passes a reference, not a value
- **WHEN** the model directs a tool to use a credential
- **THEN** it supplies an `op://` reference or symbolic name, not a value

### Requirement: Per-tool reference whitelist
Each tool SHALL declare the exact `op://` references it is permitted to resolve, defaulting to none. A reference SHALL NOT be resolvable by a tool that did not declare it, and the model SHALL NOT be able to cause resolution of an arbitrary reference.

#### Scenario: Undeclared reference is refused
- **WHEN** a tool attempts to resolve an `op://` reference it did not declare
- **THEN** the resolution is refused

#### Scenario: Arbitrary path from the model is refused
- **WHEN** the model supplies an `op://` reference outside a tool's declared whitelist
- **THEN** it is not resolved

### Requirement: Token hardening and rotation
The Service Account token SHALL be stored in a hardened, restricted-permission location (root-owned, `0600`, e.g. a systemd `EnvironmentFile`), SHALL NOT be committed to the repository or written to logs/context, and SHALL be rotated on a schedule.

#### Scenario: Token not exposed
- **WHEN** logs, context, or the repository are inspected
- **THEN** the Service Account token does not appear in any of them

#### Scenario: Scheduled rotation
- **WHEN** the rotation schedule fires
- **THEN** a new token is issued and the old one is retired
