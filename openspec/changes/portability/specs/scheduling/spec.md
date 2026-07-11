# scheduling Delta Specification

## MODIFIED Requirements

### Requirement: Schedule types
Sunny SHALL support scheduling work as a relative one-shot delay, an absolute one-shot timestamp, and a recurring cron expression. Sunny SHALL translate natural-language scheduling requests into one of these canonical forms — recurring requests (including period phrasings like "every 2 hours") translate to cron. Cron and absolute schedules SHALL be evaluated in the user's configured timezone. The former `interval` kind is retired from the creation surface (any legacy interval row keeps firing until removed).

#### Scenario: Natural language to a recurring schedule
- **WHEN** the user asks for something "every morning at 9"
- **THEN** Sunny creates a cron standing schedule evaluated in the user's timezone

#### Scenario: A period phrasing becomes cron
- **WHEN** the user asks for something "every 2 hours"
- **THEN** Sunny creates a cron schedule (e.g. `0 */2 * * *`), not an interval

#### Scenario: One-shot delay
- **WHEN** the user asks to be reminded "in 30 minutes"
- **THEN** Sunny creates a one-shot reminder that fires once after the delay

## REMOVED Requirements

### Requirement: Seeded dreaming schedule
**Reason**: Seeding system schedules into the persisted schedule store is insert-once: when the code's cron, authority, or prompt for the job changes, machines that already hold the row never pick the change up. System schedules are developer-owned and runtime-coupled, so their definitions belong in the repository and must update with the code.
**Migration**: The dreaming job becomes a builtin file-defined schedule at `agent/builtin/schedules/dreaming.md` carrying the same contract as the `ensureDreamSchedule()` seed it replaces (cron `30 */4 * * *`, silent output, authority `memory_read, memory_write, bash, file_read, file_write`, prompt directing the run to follow the dreaming skill, standard scheduled-run engine); the owner-DM thread and timezone are resolved from config at load/fire time rather than stored in the file. On boot, any legacy `dreaming` or `nightly-consolidation` rows in the persisted schedule store are removed.

## ADDED Requirements

### Requirement: Builtin file-defined system schedules
System (developer-owned) schedules SHALL be defined as markdown files at `agent/builtin/schedules/<name>.md` — YAML frontmatter carrying at least `cron`, `authority`, and output/audience settings, with the run prompt as the body — and SHALL be executed directly from those files by the scheduler. Builtin schedules SHALL NOT be inserted into or reconciled with the persisted schedule store; the deployed file is continuously authoritative, and deleting the file retires the job. Fired builtin runs SHALL use the standard scheduled-run engine and record outcomes in run history under a stable per-schedule key.

#### Scenario: Definition change takes effect on deploy
- **WHEN** a builtin schedule's cron or prompt is changed in the repository and the service restarts
- **THEN** subsequent firings use the new definition on every machine, with no per-machine migration

#### Scenario: Deleting the file retires the job
- **WHEN** a builtin schedule file is removed from the repository and the service restarts
- **THEN** the job no longer fires anywhere

#### Scenario: Builtin runs are recorded in history
- **WHEN** a builtin schedule fires
- **THEN** its outcome is recorded in run history under that schedule's stable key and can be inspected later

#### Scenario: Missing prerequisites warn loudly
- **WHEN** the runtime boots without configuration a builtin schedule requires (e.g. owner identity)
- **THEN** startup emits a prominent warning naming the schedule and the missing configuration instead of silently not running it

### Requirement: Standing schedules are state-resident files
Recurring (cron) schedules created at runtime SHALL be STANDING schedules: markdown files at `~/.sunny/state/schedules/<name>.md` in the same format as builtin schedules, created and deleted through the scheduling tools with commit-on-write to the state repository — part of the agent's portable identity, restored on a fresh host by the state clone alongside memory and skills. A standing schedule created mid-flight SHALL be live (fire-eligible) without a restart, and SHALL first fire at its next cron occurrence, never immediately. Standing files SHALL carry no machine-specific values: delivery derives from the frontmatter `audience` (a roster reference such as `person:Kate`, captured automatically when a family member creates one) or defaults to the owner's DM, resolved at fire time; an unresolvable audience SHALL degrade loudly, never crash or misdeliver. Deleting a standing schedule removes its file (committed) and stops it firing.

#### Scenario: Recurring creation produces a portable file
- **WHEN** the agent creates a cron schedule via the scheduling tools
- **THEN** a `state/schedules/<name>.md` file is written and committed, no `schedules` row is inserted, and the schedule fires at its next cron occurrence without a restart

#### Scenario: Standing schedules restore on a fresh host
- **WHEN** a fresh host clones the state repository and boots
- **THEN** the standing schedules fire on their cadence with no re-creation step

#### Scenario: A family member's standing schedule keeps its subject
- **WHEN** a family member creates a recurring schedule in their DM
- **THEN** the file carries `audience: person:<name>` so fired runs act for and deliver to them on any machine

#### Scenario: Deleting a standing schedule
- **WHEN** the agent cancels a standing schedule by id or name (ownership-scoped like rows)
- **THEN** its file is removed and committed, and it stops firing without a restart

### Requirement: Persisted schedule store holds only one-shot reminders
The persisted schedule store (`schedules` table) SHALL contain only one-shot reminders — consumable event state created at runtime, deactivated when fired. Schedule listings presented to the agent, the owner, and the dashboard SHALL merge builtin and standing file schedules with reminder rows into one view that distinguishes the three classes; schedule mutation tools SHALL reject edits to builtin schedules. Pre-existing recurring cron rows SHALL be migrated to standing files once at boot (the row deleted only after its file is committed).

#### Scenario: Listings show all three classes
- **WHEN** schedules are listed via the agent tools or the dashboard
- **THEN** builtin, standing, and reminder schedules all appear, each labeled with its class

#### Scenario: Builtin schedules cannot be mutated at runtime
- **WHEN** the agent attempts to update or delete a builtin schedule via the scheduling tools
- **THEN** the mutation is rejected with guidance that builtin schedules are changed by code deploy

#### Scenario: Legacy cron rows migrate to standing files
- **WHEN** the runtime boots with active cron rows in the persisted store
- **THEN** each becomes a `state/schedules/<name>.md` file (fields mapped 1:1) and its row is deleted
