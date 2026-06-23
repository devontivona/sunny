# Design — Observability (part 2)

> Follow-up to the `observability` change. Adds budget enforcement, the redacted
> audit log, and insights on top of part 1's tracing/trajectory/redaction
> foundation. D-OB1/D-OB2/D-OB5/D-OB7 live in the `observability` change;
> decision numbers are kept stable here (D-OB3/D-OB4/D-OB6) for traceability.

# Observability (part 2)

## Context (observability-2)

Part 1 makes Sunny's activity *visible* (Langfuse, spans, trajectories, redaction) but does not *bound* or *audit* it. Several finalized capabilities point here: scheduling's per-run cost cap and autonomous rate limit (D-SC6), the always-on token budget (`agent-memory`), and the security audit log (D-SEC7). This change consolidates them into enforcement + audit + insights, reusing part 1's Langfuse platform (D-OB7) for reporting and its redaction layer (D-OB5) for the audit log.

## Goals / Non-Goals (observability-2)

**Goals:**
- A cost/token meter that can *enforce* caps, not just report.
- A redacted audit trail of actions and secret access.
- A human-readable insights summary on demand and on a schedule.

**Non-Goals:**
- Re-implementing Langfuse's dashboards (deep exploration lives there).
- Re-deriving tracing/trajectory storage (owned by the `observability` change).

## Decisions (observability-2)

### D-OB3 — Cost/token budget meter with enforcement

Token usage and cost are metered per run and over rolling windows (e.g. per day). The meter is the **enforcement point** for the caps declared elsewhere: scheduling's per-run cost cap and autonomous rate limit (D-SC6) and the always-on budget pressure (`agent-memory`). A run that exceeds its cap is stopped and Devon is notified rather than continuing to spend. **Enforcement stays in the agent loop** (real-time, from AI SDK token usage); Langfuse (D-OB7) reports and visualizes cost/usage after the fact but cannot stop a run, so it is the reporting surface, not the control point.

### D-OB4 — Redacted audit log

Every tool invocation and secret access is written to a queryable audit log (fulfilling security D-SEC7), with all secret values redacted via part 1's redaction layer (D-OB5; ties to credentials D-CR2/D-CR4). The audit log does not depend on a 1Password Business plan. It depends on `tool-access` + `credentials` (security-tools-credentials) — those are what produce the tool/secret-access events it records.

### D-OB6 — User-facing insights

Deep exploration of cost, token usage, tool breakdown, and activity lives in **Langfuse's dashboards** (D-OB7) — Sunny does not re-implement those views. What Sunny adds is a concise insights summary **pushed over the messaging gateway** on request or on a schedule (something Langfuse cannot do), sourced from the same usage data. The scheduled (push) path needs only the gateway and scheduling; the on-request path is exposed as a gated usage tool under `tool-access` (security-tools-credentials), not as a learned `agent-skill`.

### Rejected alternatives (observability-2)

- **Report-only cost tracking:** insufficient — the caps must be enforceable (D-OB3), or autonomous runs could overspend.
- **Audit log as a separate datastore from Langfuse:** the audit log is a security control with its own query needs and must not depend on any external plan; kept as Sunny's own queryable log rather than derived from Langfuse traces.

## Risks / Trade-offs (observability-2)

- **Enforcement vs. interruption:** hard cost cutoffs can abort useful work mid-run; mitigated by notifying Devon and tuning caps.
- **Dependency ordering:** the audit log and on-request insights cannot land until security-tools-credentials provides the tool/secret-access events and the gated tool surface.

---
