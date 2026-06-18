# Design — Observability

> Carved out of the `bootstrap-sunny` change (originally Phase 6). Also owns the
> per-run cost/token budget cap that the scheduling spec defers here (was D-SC6).

# Observability

## Context (observability)

Sunny acts autonomously (self-scheduling, long jobs, credentialed actions) and spends real money on Opus. Devon needs to see what it did, bound its cost, and review what it touched. Several finalized capabilities already point here: the security audit log (D-SEC7), scheduling's per-run cost cap and autonomous rate limit (D-SC6), and the always-on token budget (`agent-memory`). This capability consolidates them.

## Goals / Non-Goals (observability)

**Goals:**
- Standard, inspectable tracing of every turn/job/tool/LLM call.
- A cost/token meter that can *enforce* caps, not just report.
- A redacted audit trail of actions and secret access.
- A human-readable insights summary on demand.
- Self-hosted, no personal data egress.

**Non-Goals:**
- Shipping telemetry to a third-party cloud APM by default.
- A bespoke tracing format (use OpenTelemetry).

## Decisions (observability)

### D-OB1 — OpenTelemetry as the tracing standard, self-hosted

Tracing uses **OpenTelemetry**: AI SDK telemetry emits spans for LLM/tool/step calls; Workflow DevKit contributes execution spans; the gateway and tool layer add their own spans. Spans export to a **self-hosted local OTel collector/backend** — no egress. A cloud APM is opt-in only.

### D-OB2 — Persistent per-run trajectories

Each turn and job records a structured trajectory (messages, tool calls + results, decisions) persisted in Postgres, for inspection, debugging, and a future skill-eval loop. Complements OTel spans (spans for live tracing; trajectories for durable replay/analysis).

### D-OB3 — Cost/token budget meter with enforcement

Token usage and cost are metered per run and over rolling windows (e.g. per day). The meter is the **enforcement point** for the caps declared elsewhere: scheduling's per-run cost cap and autonomous rate limit (D-SC6) and the always-on budget pressure (`agent-memory`). A run that exceeds its cap is stopped and Devon is notified rather than continuing to spend.

### D-OB4 — Redacted audit log

Every tool invocation and secret access is written to a queryable audit log (fulfilling security D-SEC7), with all secret values redacted (ties to credentials D-CR2/D-CR4). The audit log does not depend on a 1Password Business plan.

### D-OB5 — Redaction across all sinks

A redaction layer ensures secrets and the Service Account token never appear in traces, logs, trajectories, or insights. This is a hard property of every telemetry sink, not a per-call concern.

### D-OB6 — User-facing insights

Sunny can produce an insights summary (token usage, cost, tool breakdown, activity) deliverable over the messaging gateway on request or on a schedule.

### Rejected alternatives (observability)

- **Default cloud APM (Datadog/Honeycomb/etc.):** egresses personal activity data; rejected as default, allowed only as explicit opt-in.
- **Bespoke trace format:** rejected for OpenTelemetry's portability and tooling.
- **Report-only cost tracking:** insufficient — the caps must be enforceable (D-OB3), or autonomous runs could overspend.

## Risks / Trade-offs (observability)

- **Self-hosted telemetry is ops to run:** a local collector/backend to maintain; accepted for privacy. Kept minimal.
- **Trajectory storage growth:** Postgres trajectories accumulate; needs retention/pruning policy.
- **Enforcement vs. interruption:** hard cost cutoffs can abort useful work mid-run; mitigated by notifying Devon and tuning caps.

---

