## MODIFIED Requirements

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
A scheduled run SHALL deliver through the single delivery bus, whose destination is **resolved from the schedule's audience** — defaulting to the audience's subject (the creating conversation), NOT a hardcoded owner thread. A schedule whose run holds no messaging grant (e.g. nightly consolidation) SHALL record its outcome and send nothing. Run outcomes SHALL be retained for later inspection.

#### Scenario: Scheduled result is delivered to its audience
- **WHEN** a scheduled run created by a family member completes with a result
- **THEN** the result is delivered to that family member's conversation via the gateway

#### Scenario: Silent maintenance schedule sends nothing
- **WHEN** a `household` schedule whose run holds no messaging grant (e.g. nightly consolidation) completes
- **THEN** no proactive message is sent, and its outcome is still recorded

#### Scenario: Run history retained
- **WHEN** a scheduled run finishes
- **THEN** its outcome is recorded and can be inspected later
