## ADDED Requirements

> Adds the credential *hardening* layer over the resolution plumbing (dedicated vault,
> `op://` resolution in the tool layer, per-tool whitelist) introduced by the
> `agent-tooling` change.

### Requirement: Token hardening and rotation
The Service Account token SHALL be stored in a hardened, restricted-permission location (root-owned, `0600`, e.g. a systemd `EnvironmentFile`), SHALL NOT be committed to the repository or written to logs/context, and SHALL be rotated on a schedule. Reading the token file SHALL be on the hard blocklist.

#### Scenario: Token not exposed
- **WHEN** logs, context, or the repository are inspected
- **THEN** the Service Account token does not appear in any of them

#### Scenario: Scheduled rotation
- **WHEN** the rotation schedule fires
- **THEN** a new token is issued and the old one is retired

#### Scenario: Token file read is refused
- **WHEN** any tool attempts to read the token file
- **THEN** the attempt is refused by the hard blocklist
