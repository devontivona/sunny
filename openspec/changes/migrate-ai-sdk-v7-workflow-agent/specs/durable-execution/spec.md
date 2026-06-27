## MODIFIED Requirements

### Requirement: Conversational turns are observable on the durable runtime
Tier-1 conversational turns SHALL emit their execution to the durable workflow runtime such that each turn appears in the workflow runs inspector with its per-step trace, in addition to existing trajectory telemetry. Existing telemetry grouping (one session per thread) SHALL be preserved. Each turn SHALL produce a SINGLE coherent trace in the telemetry backend: the trace SHALL NOT contain per-step spans duplicated by durable replay of the orchestration body (e.g. one `send_message` tool span per resume). A delivered reply SHALL appear once in the trace regardless of how many times the run resumed, and the trace SHALL remain named and grouped by thread session.

#### Scenario: Turn appears in the runs inspector
- **WHEN** a conversational turn executes
- **THEN** its run and per-step trace are visible via the workflow runs inspector
- **AND** the turn's existing per-thread telemetry session grouping is unchanged

#### Scenario: One trace per turn, no replay duplication
- **WHEN** a conversational turn resumes multiple times across its durable steps
- **THEN** its telemetry trace shows each agent step and each delivered message exactly once (no replay-duplicated spans)
- **AND** the trace is named and grouped by thread session as before
