# scheduling (delta)

## ADDED Requirements

### Requirement: Seeded dreaming schedule
The runtime SHALL idempotently seed the dreaming schedule (label `dreaming`): cron every 4 hours, silent/household output (result recorded, nothing sent), authority `memory_read, memory_write, bash, file_read, file_write` (never the spawn grants — `file_write` lets the dream author skills via the skill-authoring skill; it adds ergonomics, not privilege, since `bash` can already write), and a prompt that directs the run to follow the dreaming skill. Seeding SHALL retire the legacy `nightly-consolidation` schedule row. The fired run uses the standard scheduled-run engine — no dedicated workflow or dispatch branch.

#### Scenario: Fresh install gets a dreaming schedule
- **WHEN** the runtime boots with no `dreaming` schedule present
- **THEN** the schedule is created and any legacy `nightly-consolidation` row is removed

#### Scenario: Reboot is idempotent
- **WHEN** the runtime boots and a `dreaming` schedule already exists
- **THEN** no duplicate schedule is created
