## MODIFIED Requirements

### Requirement: Non-blocking delegation with isolated context and result-only return
Sunny SHALL be able to delegate a subtask by starting a child durable run that executes in its own isolated context, and the delegation call SHALL return a handle immediately without blocking the parent. The child's intermediate tool calls and outputs SHALL NOT enter the parent's context; only what the child deliberately reports SHALL reach the parent. The child's report SHALL be its assistant TEXT — its final text delivered terminally, plus any explicit mid-task report blocks (see *Bidirectional asynchronous parent-child messaging*) — not messages emitted via a messaging tool; the child toolset SHALL NOT include a messaging tool.

#### Scenario: Delegation does not block the parent
- **WHEN** Sunny delegates a subtask
- **THEN** it receives a handle to the child run immediately
- **AND** the parent run continues or suspends without waiting inline for the child

#### Scenario: Child intermediate work stays out of the parent context
- **WHEN** a child run performs tool calls and produces large intermediate output
- **THEN** that intermediate work does not enter the parent's context
- **AND** only what the child deliberately reports — its final text and any explicit report blocks — reaches the parent

#### Scenario: Final text is the terminal report
- **WHEN** a child run completes with final assistant text
- **THEN** that text is delivered to the parent as the child's report, attributed to the child's label
- **AND** no messaging tool call is required for the report to be delivered

### Requirement: Bidirectional asynchronous parent-child messaging
A parent run SHALL be able to send a message to a still-running child, and a child run SHALL be able to proactively report (progress or result) to its parent — both delivered to the recipient, folded into its in-flight run at the next step boundary if it is running, otherwise picked up by the next run started for the recipient, using the same mechanism as owner double-text steering, without the recipient polling. Child→parent reporting SHALL be text-based: the child's final text SHALL be delivered terminally as its result, and a mid-task progress report SHALL be expressed as an explicit sentinel-delimited report block (`<report>…</report>`) in the child's interim text, extracted at a step boundary and delivered while the child continues working. A child SHALL signal "nothing to report" by making a no-report sentinel its entire final text, in which case nothing is delivered to the parent and the run still completes normally. A final text containing real content alongside a stray sentinel SHALL be delivered with the sentinel stripped — content genuinely written for the parent SHALL never be swallowed. If a child ends with neither final text nor the sentinel, the system SHALL fall back to delivering its raw interim narration (or a fixed empty-result notice when there is none), without invoking an additional model.

#### Scenario: Child reports without the parent polling
- **WHEN** a child has a result to report
- **THEN** its final text is delivered to the parent
- **AND** the parent processes it at its next step boundary if running, or a fresh parent run is started to handle it if idle, without the parent having polled

#### Scenario: Mid-task report block is delivered while the child keeps working
- **WHEN** a still-running child writes a `<report>…</report>` block in its interim text
- **THEN** the block's content is delivered to the parent at the child's next step boundary
- **AND** the child continues its task
- **AND** an already-delivered block is not delivered again by the terminal report or on replay

#### Scenario: Child signals nothing to report
- **WHEN** a child's entire final text is the no-report sentinel
- **THEN** nothing is delivered to the parent
- **AND** the child's link still closes as completed

#### Scenario: Empty final without sentinel falls back to raw narration
- **WHEN** a child ends with no final text and no sentinel
- **THEN** its raw interim narration (or a fixed empty-result notice) is delivered to the parent
- **AND** no additional model call is made to compose the report

#### Scenario: Parent steers a running child
- **WHEN** the parent sends a message to a child that is still working
- **THEN** the message is delivered to the child run and folded in at its next step boundary
- **AND** the child's prior work is not discarded
