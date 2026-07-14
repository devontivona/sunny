# scheduling Delta Specification

## MODIFIED Requirements

### Requirement: Scheduled output delivery and history
A scheduled run's terminal output SHALL be a **report**, dispatched through the single delivery bus and **resolved from the schedule's audience**: for a delivering (`person`/`thread`) audience, the report is appended to that audience's conversation thread as an attributed inbound message (`<label> (scheduled): …`) and a normal conversational turn is woken to mediate it into user-facing speech — the scheduled run SHALL NOT gateway-send its terminal output itself. A `household` schedule's terminal result SHALL be recorded without waking anything (the silent pipeline/maintenance case); its run MAY still deliberately fan out to roster members via the `message` tool. A scheduled run producing media SHALL reference the file in its report for the mediating turn to send, rather than sending images itself. A run whose final text contains the reporter silence sentinel (`<no-report/>`) SHALL wake nothing. Raw run outcomes SHALL be retained verbatim in run history regardless of what the mediating turn relays.

#### Scenario: Scheduled result is mediated into the conversation
- **WHEN** a scheduled run created by a family member completes with a report
- **THEN** the report lands on that family member's conversation thread attributed `(scheduled)`, and a woken conversational turn relays it to them in voice with the thread's context

#### Scenario: Nothing-to-report wakes nothing
- **WHEN** a delivering scheduled run's final text contains `<no-report/>`
- **THEN** no conversation is woken and nothing is delivered, and the raw final text is still recorded in run history

#### Scenario: Household terminal result is recorded, not sent
- **WHEN** a `household` schedule (e.g. the dreaming job or an artifact-producing pipeline) completes
- **THEN** no message is sent and no conversation is woken, and its outcome is still recorded

#### Scenario: Household run can fan out deliberately
- **WHEN** a `household` scheduled run calls `message` for a roster member
- **THEN** that member receives it in their own conversation, while the run's terminal result is still only recorded

#### Scenario: Run history retained
- **WHEN** a scheduled run finishes
- **THEN** its raw outcome is recorded and can be inspected later, independent of what (if anything) the mediating turn relayed

## ADDED Requirements

### Requirement: Standing schedules declare their audience; outputTarget is retired
A standing-schedule file SHALL declare its addressing with an `audience:` frontmatter key — `person:<roster name>` (the default when absent is the owner) or `household` (record-only) — replacing the retired `outputTarget: user|silent` field. The loader SHALL migrate a legacy `outputTarget:` key on first read (rewriting the file and logging the migration once) and SHALL refuse the legacy key thereafter. Builtin schedule files use the same format. Persisted one-shot schedule rows MAY retain the legacy column, read through the existing audience-derivation shim; no destructive DB migration is required.

#### Scenario: Legacy frontmatter migrates once
- **WHEN** the loader reads a standing-schedule file carrying `outputTarget: silent`
- **THEN** the file is rewritten with `audience: household`, the migration is logged, and subsequent loads see only the `audience:` key

#### Scenario: Absent audience defaults to the owner
- **WHEN** a standing-schedule file carries no `audience:` key
- **THEN** the fired run's reports are routed to the owner's conversation loop
