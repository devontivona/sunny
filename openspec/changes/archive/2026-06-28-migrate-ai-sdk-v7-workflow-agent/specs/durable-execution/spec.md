## MODIFIED Requirements

### Requirement: Conversational turns are observable on the durable runtime
Tier-1 conversational turns SHALL emit their execution to the durable workflow runtime such that each turn appears in the workflow runs inspector with its per-step trace. Existing per-thread telemetry session grouping (one session per thread) SHALL be preserved for the telemetry that IS emitted (the in-process / main-realm paths — e.g. the delivery-recovery pass).

External AI-SDK trajectory telemetry (OpenTelemetry → Langfuse) for the DURABLE path is NOT emitted in this version, and SHALL be **explicitly disabled** (`telemetry.isEnabled: false` on the durable `WorkflowAgent` calls) rather than silently producing no spans. This is a known AI SDK v7 + Workflow DevKit limitation: the WDK runs the agent loop in an isolated `node:vm` realm that the global `registerTelemetry` integration cannot reach, so any apparently-enabled telemetry would emit nothing. The prior "single clean trace per turn, no replay duplication" guarantee is therefore DEFERRED pending upstream support (vercel/ai#12164) or adoption of the event-forwarding bridge (implemented + proven, kept on a shelf branch). Re-enabling is a localized change (restore the per-call telemetry integration); the rest of the durable runtime is unaffected.

#### Scenario: Turn appears in the runs inspector
- **WHEN** a conversational turn executes
- **THEN** its run and per-step trace are visible via the workflow runs inspector
- **AND** the turn's existing per-thread telemetry session grouping is unchanged for any telemetry it emits

#### Scenario: Durable external telemetry is explicitly disabled, not silently failing
- **WHEN** a conversational turn runs the durable `WorkflowAgent`
- **THEN** external AI-SDK OpenTelemetry/Langfuse spans are not emitted for the durable path
- **AND** this is configured explicitly (`telemetry.isEnabled: false` with an in-code rationale), so the absence is intentional and documented rather than an apparent-but-broken integration
