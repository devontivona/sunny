## ADDED Requirements

### Requirement: The vault is the authorization boundary
Sunny SHALL access secrets only through a 1Password Service Account scoped to a dedicated `Sunny` vault that contains only the items Sunny needs, using read-only (`read_items`) permission. Sunny SHALL NOT have access to any vault outside the dedicated vault, and SHALL NOT be able to add, modify, or delete items in it. Because Sunny cannot write the vault, the vault's contents are exactly the set of credentials the owner has authorized, and only the owner can change that set — the act of adding an item to the vault IS the grant.

#### Scenario: Only the dedicated vault is reachable
- **WHEN** Sunny attempts to resolve a secret
- **THEN** it can resolve items only from the dedicated `Sunny` vault
- **AND** items in the user's other vaults are unreadable

#### Scenario: Read-only — Sunny cannot grant itself access
- **WHEN** Sunny attempts to add, modify, or delete an item in the vault
- **THEN** the attempt fails (read-only), so the set of reachable credentials can only be changed by the owner

### Requirement: The model never receives secret values
Sunny's reasoning model SHALL only ever handle `op://` references or symbolic credential names, never resolved secret values. Secret values SHALL be resolved in the tool-execution layer at the point of use and SHALL NOT appear in prompts, tool arguments, model responses, or logs.

#### Scenario: Value resolved outside the model
- **WHEN** a tool needs a secret
- **THEN** the value is resolved by the SDK in the tool layer and injected into the request
- **AND** the value is never placed into model-visible text or logs

#### Scenario: Model passes a reference, not a value
- **WHEN** the model directs a tool to use a credential
- **THEN** it supplies an `op://` reference or symbolic name, not a value

### Requirement: Credential mapping stored in a registry, not in skills
The mapping from a symbolic credential name to its `op://` reference SHALL be stored in a dedicated, structured credential registry that is owner-reviewable and version-controlled (alongside memory and skills), and SHALL contain references and metadata only, never secret values. Skills (`SKILL.md`) SHALL NOT carry vault references; a skill refers to a capability, not a credential location, so it stays portable.

#### Scenario: References live in the registry
- **WHEN** Sunny needs to use a credential by name
- **THEN** the name is resolved to an `op://` reference via the registry, then to a value in the tool layer

#### Scenario: Skills stay free of vault references
- **WHEN** a skill is authored or installed
- **THEN** it does not contain any `op://` reference; it invokes a capability that resolves credentials itself

### Requirement: Owner-provisioned credentials via a request flow
When Sunny needs a credential it does not yet have, it SHALL request it from the owner (stating what it is for) rather than fabricate or assume a reference. Upon the owner adding the item to the vault and providing its reference, Sunny SHALL record the name→reference mapping in the registry and verify the reference resolves to a value without surfacing that value.

#### Scenario: Sunny requests a missing credential
- **WHEN** a task needs a credential with no registry entry
- **THEN** Sunny asks the owner to add it to the vault and provide its reference, rather than guessing one

#### Scenario: Provisioned reference is verified, not exposed
- **WHEN** the owner provides a new reference and Sunny records it
- **THEN** Sunny test-resolves it to confirm it points at a real value
- **AND** the value itself is never shown to the model or logged
