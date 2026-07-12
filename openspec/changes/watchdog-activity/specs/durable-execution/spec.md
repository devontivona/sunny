# durable-execution Delta Specification

## ADDED Requirements

### Requirement: Activity-aware turn watchdog
A conversational turn-run SHALL be bounded by two thresholds, not a single wall clock: it SHALL be abandoned when no observable activity (run-stream output — model deltas, tool calls, tool results at step boundaries) has occurred for the inactivity budget (`turnInactivityMs`, default 600000ms), or when total runtime exceeds the hard cap (`turnWatchdogMs`). A turn that keeps producing activity SHALL NOT be abandoned before the hard cap. Abandonment semantics are unchanged: cancel the run, tell the user on-thread, retire the unanswered inbound (never a silent re-run).

#### Scenario: A long tool-heavy turn is not killed while healthy
- **WHEN** a turn runs past the inactivity budget in total time but keeps streaming activity (steps completing, tool results arriving)
- **THEN** it continues until it finishes or hits the hard cap

#### Scenario: A stalled stream is caught at the inactivity budget
- **WHEN** a turn produces no run-stream activity for the full inactivity budget (e.g. a hung model stream)
- **THEN** it is abandoned then — not at the (much larger) hard cap

#### Scenario: The hard cap still bounds runaway turns
- **WHEN** a turn is still producing activity at the hard cap
- **THEN** it is abandoned with the standard cancel/notify/retire path

### Requirement: Abandonment settles the run's observable state
When the watchdog abandons a turn-run, every live view of that run SHALL reach a terminal state: the dashboard's live/active-run tracking SHALL show the run as ended (errored), and the stream bridge SHALL be torn down rather than left waiting on a cancelled run's never-closing stream. Settling SHALL be idempotent (the abandon path and the bridge's own completion may both fire).

#### Scenario: Dashboard does not show a killed run as running
- **WHEN** the watchdog abandons a turn-run
- **THEN** the dashboard's live views show the run as ended (not still running), without waiting for a page reload or a new turn

#### Scenario: The bridge task does not leak
- **WHEN** a run is cancelled while its stream bridge is blocked on a read
- **THEN** the bridge's reader is cancelled and its cleanup (typing stop, live settle) runs promptly
