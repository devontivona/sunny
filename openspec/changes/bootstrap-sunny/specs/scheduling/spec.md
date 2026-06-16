## ADDED Requirements

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
Sunny SHALL be able to create, list, update, and delete its own schedules during interactive turns.

#### Scenario: Agent schedules itself
- **WHEN** Sunny decides recurring work is needed (e.g. nightly memory consolidation)
- **THEN** it creates the schedule itself without user intervention

#### Scenario: Agent inspects and removes a schedule
- **WHEN** Sunny needs to review or cancel a schedule
- **THEN** it can list existing schedules and delete one

### Requirement: Anti-recursion guard on scheduled runs
A job executing as a scheduled run SHALL NOT be able to create, modify, or delete schedules. Schedule-management actions SHALL be disabled within scheduled executions.

#### Scenario: Scheduled run cannot self-schedule
- **WHEN** a job running as a scheduled execution attempts to create a new schedule
- **THEN** the action is disallowed

#### Scenario: Interactive run can still schedule
- **WHEN** Sunny is handling a normal interactive turn (not a scheduled run)
- **THEN** it can create, modify, or delete schedules

### Requirement: Scheduled output delivery and history
A scheduled run SHALL deliver its result to a configured messaging target through the gateway, defaulting to a direct message to the user, without the job issuing an explicit send. Run outcomes SHALL be retained for later inspection.

#### Scenario: Scheduled result is delivered
- **WHEN** a scheduled run completes and produces a result
- **THEN** the result is delivered to the configured target via the messaging gateway

#### Scenario: Run history retained
- **WHEN** a scheduled run finishes
- **THEN** its outcome is recorded and can be inspected later

### Requirement: Cost and rate limits on autonomous runs
Scheduled runs SHALL be subject to a configurable per-run cost/token cap, and the scheduler SHALL be subject to a rate limit. When a run exceeds its cap, it SHALL stop and notify the user rather than continue spending.

#### Scenario: Run exceeds its cost cap
- **WHEN** a scheduled run reaches its configured cost/token cap
- **THEN** the run stops and the user is notified

#### Scenario: Scheduler rate limit
- **WHEN** scheduled runs would fire more frequently than the configured rate limit allows
- **THEN** the scheduler throttles execution rather than running them all immediately
