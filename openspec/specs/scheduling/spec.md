# scheduling Specification

## Purpose
TBD - created by archiving change bootstrap-sunny. Update Purpose after archive.
## Requirements
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

### Requirement: Durable, restart-surviving schedules
Schedule definitions SHALL be persisted so they survive process restarts, and a due schedule SHALL fire as a durable Tier-2 job. A schedule SHALL NOT be lost or silently dropped by a restart.

#### Scenario: Schedule survives restart
- **WHEN** the process restarts after a recurring schedule was created
- **THEN** the schedule still exists and continues to fire at its scheduled times

#### Scenario: Due one-shot missed during downtime
- **WHEN** a one-shot schedule's time passed while the host was down
- **THEN** that schedule runs once after restart

#### Scenario: Recurring schedule does not backfill
- **WHEN** multiple occurrences of a recurring schedule were missed while the host was down
- **THEN** Sunny resumes firing forward without running every missed occurrence

### Requirement: Self-scheduling
Sunny SHALL be able to create, list, update, and delete schedules **during interactive turns of any trusted DM (owner or family)** — not only owner turns. A created schedule SHALL carry an **audience** (defaulting to the creating conversation's subject) so that its fired run frames itself for, and delivers to, that subject rather than the owner by default. The self-scheduling tools SHALL be registered on the durable conversational turn (their omission after the durable-main-loop migration was a regression against this requirement).

#### Scenario: Agent schedules itself
- **WHEN** Sunny decides recurring work is needed (e.g. the recurring dreaming job)
- **THEN** it creates the schedule itself without user intervention

#### Scenario: A family member can schedule for themselves
- **WHEN** a family member asks in their DM to be reminded on a recurring basis
- **THEN** Sunny creates a schedule whose audience is that family member, and the fired run addresses and delivers to them, not the owner

#### Scenario: Agent inspects and removes a schedule
- **WHEN** Sunny needs to review or cancel a schedule
- **THEN** it can list existing schedules and delete one

### Requirement: Anti-recursion guard on scheduled runs
A job executing as a scheduled run SHALL NOT be able to create, modify, or delete schedules. This SHALL be enforced as **authority attenuation** — a scheduled run is not endowed the schedule-management grant by default — rather than as a bespoke special case, with the spawn derivation-tree depth cap as a backstop.

#### Scenario: Scheduled run cannot self-schedule
- **WHEN** a job running as a scheduled execution attempts to create a new schedule
- **THEN** the action is disallowed because the run was not endowed the schedule grant

#### Scenario: Interactive run can still schedule
- **WHEN** Sunny is handling a normal interactive turn (not a scheduled run)
- **THEN** it can create, modify, or delete schedules

### Requirement: Scheduled output delivery and history
A scheduled run's terminal output SHALL be a **report**, dispatched through the single delivery bus and **resolved from the schedule's audience**: for a delivering (`agent(byPerson | byThread)`) audience, the report is appended to that audience's conversation thread as an attributed inbound message (`<label> (scheduled): …`) and a normal conversational turn is woken to mediate it into user-facing speech — the scheduled run SHALL NOT gateway-send its terminal output itself. A `nobody` schedule's terminal result SHALL be recorded without waking anything (the silent pipeline/maintenance case); its run MAY still deliberately fan out to roster members via the `message` tool. A scheduled run producing media SHALL reference the file in its report for the mediating turn to send, rather than sending images itself. A run whose final text contains the reporter silence sentinel (`<no-report/>`) SHALL wake nothing. Raw run outcomes SHALL be retained verbatim in run history regardless of what the mediating turn relays.

#### Scenario: Scheduled result is mediated into the conversation
- **WHEN** a scheduled run created by a family member completes with a report
- **THEN** the report lands on that family member's conversation thread attributed `(scheduled)`, and a woken conversational turn relays it to them in voice with the thread's context

#### Scenario: Nothing-to-report wakes nothing
- **WHEN** a delivering scheduled run's final text contains `<no-report/>`
- **THEN** no conversation is woken and nothing is delivered, and the raw final text is still recorded in run history

#### Scenario: Nobody-audience terminal result is recorded, not sent
- **WHEN** a `nobody` schedule (e.g. the dreaming job or an artifact-producing pipeline) completes
- **THEN** no message is sent and no conversation is woken, and its outcome is still recorded

#### Scenario: Nobody-audience run can fan out deliberately
- **WHEN** a `nobody`-audience scheduled run calls `message` for a roster member
- **THEN** that member receives it in their own conversation, while the run's terminal result is still only recorded

#### Scenario: Run history retained
- **WHEN** a scheduled run finishes
- **THEN** its raw outcome is recorded and can be inspected later, independent of what (if anything) the mediating turn relayed

## ADDED Requirements

### Requirement: Bounded autonomous dispatch
The scheduler SHALL bound how many due schedules it dispatches per tick, so a backlog (e.g. accumulated during downtime) cannot fire all at once. Per-run cost/token budget caps with stop-and-notify are out of scope for scheduling and are provided by the observability budget meter (a separate change).

#### Scenario: Backlog does not stampede
- **WHEN** more schedules are due in a single tick than the configured per-tick limit
- **THEN** the scheduler dispatches up to the limit and defers the rest to subsequent ticks

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

### Requirement: Standing schedules declare their audience; outputTarget is retired
A standing-schedule file SHALL declare its addressing with an `audience:` frontmatter key — `person:<roster name>` (the default when absent is the owner) or `nobody` (record-only; `household` accepted as the legacy spelling and normalized on load) — replacing the retired `outputTarget: user|silent` field. The loader SHALL migrate a legacy `outputTarget:` key or legacy spelling on first read (rewriting the file and logging the migration once). Builtin schedule files use the same format. The persisted `output_target` column is backfilled into the audience encoding (`silent` → `nobody`) and dropped (migration 0013); a null stored audience means the creating thread's agent.

#### Scenario: Legacy frontmatter migrates once
- **WHEN** the loader reads a standing-schedule file carrying `outputTarget: silent`
- **THEN** the file is rewritten with `audience: nobody`, the migration is logged, and subsequent loads see only the `audience:` key

#### Scenario: Absent audience defaults to the owner
- **WHEN** a standing-schedule file carries no `audience:` key
- **THEN** the fired run's reports are routed to the owner's conversation loop
