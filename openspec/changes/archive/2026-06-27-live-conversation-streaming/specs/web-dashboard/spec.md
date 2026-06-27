## MODIFIED Requirements

### Requirement: Conversation view
The dashboard SHALL show conversation from the message store, grouped by thread, in **chronological order within a scroll region that automatically stays pinned to the bottom as new activity streams** — so the newest message (including an in-flight turn) remains in view without manual scrolling — and SHALL provide a control to jump back to the latest when the owner has scrolled up. It SHALL include each turn's role, timestamp, and delivered text, and SHALL render each of Sunny's turns as its **per-step activity** from the stored `UIMessage` parts: model thinking/scratch, the delivered messages, and tool calls (tool name, with full arguments and result/error available without cluttering the thread — e.g. behind an expandable panel with the payload formatted). It SHALL render message images (inbound and outbound) inline in the thread, served through an authenticated dashboard route (never exposing media without the dashboard's auth gate). It SHALL support keyword search over message history. The view SHALL remain observe-only — rendering steps and tool activity SHALL NOT add any control to send, cancel, retry, or edit.

#### Scenario: Conversation auto-scrolls to the newest activity
- **WHEN** the owner opens the conversation page for a thread, or new activity streams while it is open
- **THEN** messages are shown in chronological order and the view stays pinned to the newest message as it arrives
- **AND** when the owner scrolls up, a control to jump back to the latest is offered

#### Scenario: Turn renders as per-step activity
- **WHEN** the owner views one of Sunny's turns
- **THEN** the turn's steps are shown, including model thinking/scratch, the delivered messages, and each tool call with its name
- **AND** the full tool arguments and result (or error) are available in a formatted view without cluttering the thread

#### Scenario: Message images are shown
- **WHEN** a thread contains a message with an image attachment
- **THEN** the image is rendered inline in the conversation view, served only through the authenticated dashboard route

#### Scenario: Search history
- **WHEN** the owner enters a keyword search
- **THEN** matching past messages are returned

#### Scenario: Conversation view stays observe-only
- **WHEN** the owner views a turn's steps and tool activity
- **THEN** no control is presented to send, cancel, retry, or edit any message, turn, or tool call

### Requirement: Activity and health view
The dashboard SHALL present per-turn activity metrics derived from stored turn metadata (token usage including cached/written, delivery path, step count) and a service health panel (application, database, scheduler, gateway status, and the count of unprocessed inbound messages). For any **in-flight** turn or job, the activity view SHALL additionally surface its live run state: status (running / waiting-on-tool / finished / errored), elapsed time, current step count, live token usage including cache read/write, the active model and effort, and a link to the run's trajectory trace.

#### Scenario: View activity and health
- **WHEN** the owner opens the activity/health page
- **THEN** recent turns are shown with token usage, cache read/write, delivery path, and step count
- **AND** a health panel shows whether the service, database, scheduler, and gateway are healthy

#### Scenario: In-flight run state is shown
- **WHEN** a turn or job is currently running
- **THEN** its live status, elapsed time, current step count, live token usage, active model/effort, and a link to its trajectory trace are shown

## ADDED Requirements

### Requirement: Live activity streaming on the conversation view
While a turn or background job is running, the dashboard's conversation/run view SHALL receive incremental live updates over a read-only server-push channel served under `/dashboard/api` behind the dashboard's existing authentication gate, and SHALL reflect them without a manual refresh. The live stream SHALL deliver, at minimum, new step boundaries, tool-call starts and their results/errors, the in-progress assistant text, run status transitions, and token-usage deltas. When the run completes, the view SHALL settle to the persisted record (no divergence between the streamed state and the stored turn/job). The stream SHALL be subject to the same secret redaction as all other telemetry sinks (no secret values, no token-bearing URLs) and SHALL carry no control affordance.

#### Scenario: In-flight turn updates without refresh
- **WHEN** Sunny is processing a turn while the owner has the conversation view open
- **THEN** new steps, tool-call starts and results, in-progress assistant text, status changes, and token deltas appear live without a manual page refresh

#### Scenario: Streamed state settles to the persisted record
- **WHEN** a streamed turn or job completes
- **THEN** the view shows the same content as the persisted turn/job record, with no divergence from what was streamed

#### Scenario: Live stream is authenticated, redacted, and observe-only
- **WHEN** the live event channel is consumed
- **THEN** it is served only to an authenticated dashboard session
- **AND** it contains no secret values or token-bearing URLs
- **AND** it exposes no control to send, cancel, retry, or edit

#### Scenario: No active run yields no stream errors
- **WHEN** the owner opens the conversation view and nothing is currently running
- **THEN** the most-recent persisted activity is shown and the view does not error while idle

### Requirement: Home-page live indicator with shortcut to the active run
When Sunny is actively streaming a turn or running a background job, the home page SHALL display an "active now" indicator that links directly to the live conversation (or job) view for that run. When more than one run is active, the indicator SHALL make each active run reachable. When nothing is active, the indicator SHALL be absent (or show an idle state) and SHALL NOT misreport activity. The indicator SHALL remain observe-only.

#### Scenario: Active run surfaces on the home page
- **WHEN** a turn or background job is actively running
- **THEN** the home page shows an "active now" indicator with a shortcut that deep-links to that run's live view

#### Scenario: Multiple active runs are reachable
- **WHEN** more than one turn or job is active at once
- **THEN** the home-page indicator makes each active run reachable from its shortcut

#### Scenario: Idle home page does not show false activity
- **WHEN** nothing is currently running
- **THEN** the home page shows no active indicator (or an explicit idle state) and does not deep-link to a non-existent run

### Requirement: Live run view reused for background jobs
The dashboard SHALL render an actively-running Tier-2 durable job in the same per-step, live-streaming run view used for conversational turns — showing the job's steps, tool calls and results, status, elapsed time, and live token usage. A running job SHALL be reachable from the home-page live indicator. The job run view SHALL remain observe-only — it SHALL NOT expose any control to trigger, pause, cancel, or retry a job.

#### Scenario: Running job is observable in the live run view
- **WHEN** a background job is actively running
- **THEN** its steps, tool calls and results, status, elapsed time, and live token usage are shown in the same live run view used for turns

#### Scenario: Running job is reachable and observe-only
- **WHEN** the owner opens a running job's live view from the home indicator
- **THEN** the job's live activity is shown
- **AND** no control is presented to trigger, pause, cancel, or retry the job
