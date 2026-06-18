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

### Requirement: Deterministic time control
Time-dependent behavior (schedule/cron evaluation, date-tagged memory facts, the scheduler ticker) SHALL be testable with controlled time so tests advance time deterministically rather than waiting in real time, without requiring production code to change.

#### Scenario: Scheduled job fires under controlled time
- **WHEN** a test sets a schedule and advances controlled time past its due time
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

### Requirement: Initial coverage of the current surface
This change SHALL deliver written tests covering the existing foundation, not only the harness. The **unit** lane SHALL cover, at minimum: sender authorization and identity normalization; schedule duration/next-run (once/interval/cron) computation; memory write semantics (add/replace/remove), topic-name sanitization, and core-file overflow; system-prompt assembly including its byte-stability under unchanged inputs; the turn delivery classification (`send_message` vs fallback vs silence), trailing non-user-message trimming, and group speaker-prefixing; config schema defaults/validation; and dispatcher dedup, eviction, and steering-vs-new-run behavior. The **integration** lane SHALL cover, at minimum: inbound dedup, recent-window ordering, and full-text keyword recall against real Postgres; the scheduler ticker dispatching due schedules and advancing next-run; and the agent loop end-to-end with the mock model and fake gateway (including the fallback-delivery path and the persisted per-turn record).

#### Scenario: Foundation has written coverage
- **WHEN** this change is complete
- **THEN** the listed unit and integration behaviors each have at least one test
- **AND** those tests run in the default CI gate

#### Scenario: send_message guard is covered both ways
- **WHEN** the loop coverage runs
- **THEN** a turn that calls `send_message` is recorded as delivered via `send_message`
- **AND** a turn that produces only private scratch is delivered as fallback text and flagged
