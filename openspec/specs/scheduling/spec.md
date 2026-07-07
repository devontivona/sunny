# scheduling Specification

## Purpose
TBD - created by archiving change bootstrap-sunny. Update Purpose after archive.
## Requirements
### Requirement: Schedule types
Sunny SHALL support scheduling work as a relative one-shot delay, an absolute one-shot timestamp, a recurring interval, and a cron expression. Sunny SHALL translate natural-language scheduling requests into one of these canonical forms. Cron and absolute schedules SHALL be evaluated in the user's configured timezone.

#### Scenario: Natural language to a recurring schedule
- **WHEN** the user asks for something "every morning at 9"
- **THEN** Sunny creates a cron schedule evaluated in the user's timezone

#### Scenario: One-shot delay
- **WHEN** the user asks to be reminded "in 30 minutes"
- **THEN** Sunny creates a relative one-shot schedule that fires once after the delay

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
- **WHEN** Sunny decides recurring work is needed (e.g. nightly memory consolidation)
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
A scheduled run SHALL deliver through the single delivery bus, whose destination is **resolved from the schedule's audience** — defaulting to the audience's subject (the creating conversation), NOT a hardcoded owner thread. A `household` schedule's TERMINAL result SHALL be recorded without being sent (no single recipient); its run MAY still deliberately fan out to roster members via the `message` tool (the audience axis — e.g. a household job briefing each member), so a maintenance run like nightly consolidation is silent because it has nothing to send, not because it is muzzled. Run outcomes SHALL be retained for later inspection.

#### Scenario: Scheduled result is delivered to its audience
- **WHEN** a scheduled run created by a family member completes with a result
- **THEN** the result is delivered to that family member's conversation via the gateway

#### Scenario: Household terminal result is recorded, not sent
- **WHEN** a `household` schedule (e.g. nightly consolidation) completes with a result and sent no messages
- **THEN** no proactive message is sent, and its outcome is still recorded

#### Scenario: Household run can fan out deliberately
- **WHEN** a `household` scheduled run calls `message` for a roster member
- **THEN** that member receives it in their own conversation, while the run's terminal result is still only recorded

#### Scenario: Run history retained
- **WHEN** a scheduled run finishes
- **THEN** its outcome is recorded and can be inspected later

### Requirement: Bounded autonomous dispatch
The scheduler SHALL bound how many due schedules it dispatches per tick, so a backlog (e.g. accumulated during downtime) cannot fire all at once. Per-run cost/token budget caps with stop-and-notify are out of scope for scheduling and are provided by the observability budget meter (a separate change).

#### Scenario: Backlog does not stampede
- **WHEN** more schedules are due in a single tick than the configured per-tick limit
- **THEN** the scheduler dispatches up to the limit and defers the rest to subsequent ticks

