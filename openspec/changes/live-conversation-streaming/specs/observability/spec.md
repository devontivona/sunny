## ADDED Requirements

### Requirement: Live in-flight run event source
Sunny SHALL expose an in-process, read-only event source that publishes step-level activity for **in-flight** turns and durable jobs as it happens — step boundaries, tool-call starts and their results/errors, in-progress assistant text, run status transitions (running / waiting-on-tool / finished / errored), and token-usage deltas (including cache read/write). This live source SHALL be derived from the same activity already captured for trajectories; it SHALL NOT require a separate persisted store and SHALL NOT alter what trajectories record. Publishing live events SHALL NOT modify the byte-stable cached system prefix, and live events SHALL pass through the same secret-redaction layer as all other telemetry sinks.

#### Scenario: In-flight activity is published live
- **WHEN** a turn or job is running
- **THEN** its step boundaries, tool-call starts/results, in-progress assistant text, status transitions, and token deltas are published to subscribers of the live event source as they occur

#### Scenario: Live source does not change persistence or the cached prefix
- **WHEN** live events are published for a run
- **THEN** no separate trajectory store is introduced and the persisted trajectory is unchanged
- **AND** the always-on cached system prefix is not modified by the publish path

#### Scenario: Live events are redacted
- **WHEN** any live run event is published
- **THEN** it contains no secret values and no Service Account token
