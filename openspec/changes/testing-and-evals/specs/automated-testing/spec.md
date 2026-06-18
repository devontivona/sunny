## ADDED Requirements

### Requirement: Deterministic test runner and lanes
Sunny SHALL have an automated test suite run by a single test runner, organized into a **unit** lane (pure logic, no I/O) and an **integration** lane (real modules against ephemeral infrastructure). Both lanes SHALL be deterministic and SHALL NOT call any paid LLM API or external network service (Sendblue, Anthropic).

#### Scenario: Unit lane runs without external services
- **WHEN** the unit lane is run
- **THEN** it exercises pure logic with no network, no database, and no LLM calls
- **AND** it produces the same result on every run

#### Scenario: Integration lane runs against ephemeral infra
- **WHEN** the integration lane is run
- **THEN** it wires real modules against a disposable Postgres with migrations applied fresh
- **AND** it uses no paid LLM API and no external messaging service

### Requirement: Mock language model seam
The agent loop SHALL be drivable by a mock language model that returns scripted text and tool calls deterministically, so the loop, dispatcher, and tool wiring can be tested without invoking a real model.

#### Scenario: Scripted tool call drives the loop
- **WHEN** a test runs the agent loop with a mock model scripted to call a tool
- **THEN** the loop dispatches that tool and observes its result deterministically
- **AND** no real LLM request is made

### Requirement: Fake gateway driver seam
There SHALL be a fake `Gateway` driver that records outbound messages and lets tests inject inbound events, used in place of the Sendblue driver throughout testing.

#### Scenario: Outbound captured, inbound injected
- **WHEN** a test injects an inbound message through the fake gateway and the agent replies
- **THEN** the reply is captured by the fake gateway for assertion
- **AND** nothing is sent to Sendblue

### Requirement: Ephemeral database fixture
Integration tests SHALL run against a disposable Postgres instance whose schema is created from the project's Drizzle migrations at setup and discarded at teardown, isolated from any development or production database.

#### Scenario: Fresh schema per integration run
- **WHEN** the integration lane starts
- **THEN** a disposable Postgres is provisioned and migrated to current schema
- **AND** test data does not touch the dev or production database

#### Scenario: Keyword recall is covered
- **WHEN** an integration test seeds messages and queries conversation recall
- **THEN** the tsvector/FTS recall path returns the expected matches against the real database

### Requirement: Injectable clock for time-dependent code
Time-dependent behavior (schedule/cron evaluation, date-tagged memory facts, the scheduler ticker) SHALL be testable with an injectable clock so tests can advance time deterministically rather than waiting in real time.

#### Scenario: Scheduled job fires under a controlled clock
- **WHEN** a test sets a schedule and advances the injected clock past its due time
- **THEN** the scheduler dispatches the job deterministically without real-time waiting

### Requirement: Durable workflow step coverage
The durable Tier-2 execution path SHALL have integration coverage that verifies step-level execution and idempotency (a replayed step does not double-apply its effect), to the extent the Workflow DevKit's test support allows.

#### Scenario: Replayed step does not double-apply
- **WHEN** a durable workflow step is executed and then replayed
- **THEN** its observable effect occurs exactly once

### Requirement: CI gate on every change
The unit and integration lanes plus type-checking SHALL run automatically in CI on every change and SHALL block merge on failure. Evals SHALL NOT run in this default gate.

#### Scenario: CI blocks on a failing test
- **WHEN** a change makes a unit or integration test fail
- **THEN** CI reports failure and the change is blocked from merge

#### Scenario: Default CI does not spend on evals
- **WHEN** the default CI gate runs
- **THEN** it performs typecheck, unit, and integration lanes only
- **AND** it does not invoke the paid eval harness
