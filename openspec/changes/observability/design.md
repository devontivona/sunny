# Design — Observability

> Carved out of the `bootstrap-sunny` change (originally Phase 6). Scoped to the
> tracing/trajectory foundation (Langfuse, spans, redaction gate); budget
> enforcement, the audit log, and insights move to the `observability-2` change.

# Observability

## Context (observability)

Sunny acts autonomously (self-scheduling, long jobs, credentialed actions) and spends real money on Opus. Devon needs to see what it did, bound its cost, and review what it touched. This change delivers the **visibility** half — standard tracing and durable trajectories, self-hosted with no egress. Bounding cost (the per-run cap scheduling defers, D-SC6; the always-on budget from `agent-memory`) and reviewing access (the security audit log, D-SEC7) move to the **`observability-2`** change.

## Goals / Non-Goals (observability)

**Goals:**
- Standard, inspectable tracing of every turn/job/tool/LLM call.
- Durable, replayable per-run trajectories.
- Redaction at every telemetry sink (no secret leakage).
- Self-hosted, no personal data egress.

(Budget enforcement, the audit log, and insights are goals of `observability-2`.)

**Non-Goals:**
- Shipping telemetry to a third-party cloud APM by default.
- A bespoke tracing format (use OpenTelemetry).

## Decisions (observability)

### D-OB1 — OpenTelemetry as the tracing standard, self-hosted

Tracing uses **OpenTelemetry**: AI SDK telemetry emits spans for LLM/tool/step calls; Workflow DevKit contributes execution spans; the gateway and tool layer add their own spans. Spans export over OTLP to **self-hosted Langfuse** (D-OB7) — no egress. A cloud APM is opt-in only.

### D-OB2 — Per-run trajectories are Langfuse traces

Each turn and job records a structured trajectory (messages, tool calls + results, decisions). Rather than a bespoke Postgres trajectory store, **trajectories are the Langfuse traces themselves** (D-OB7): the OTLP spans Sunny already emits become the durable, inspectable record, available for replay/analysis and a future skill-eval loop (Langfuse datasets/evals). This consolidates trajectory storage into one tool and removes the separate Postgres trajectory schema originally planned here.

### D-OB5 — Redaction across all sinks

A redaction layer ensures secrets and the Service Account token never appear in traces, logs, trajectories, or insights. This is a hard property of every telemetry sink, not a per-call concern.

### D-OB7 — Langfuse as the self-hosted observability platform

Sunny uses **self-hosted Langfuse** (its Docker Compose stack, on this host) as the single observability platform: the OTLP backend for all spans (D-OB1), the durable trace/trajectory store (D-OB2), and the cost/usage dashboards that `observability-2` builds reporting and insights on. On a 10-core / 31 GB host the stack's footprint (~3–4 GB, Clickhouse included) is comfortably absorbed, and `docker compose` handles storage setup at this scale. Langfuse does **not** own redaction-at-source (D-OB5), enforcement, or the security audit log — those remain Sunny's (enforcement and audit are specified in `observability-2`). Self-hosted preserves the no-egress property; Langfuse Cloud is not used.

### Rejected alternatives (observability)

- **Default cloud APM (Datadog/Honeycomb/LangSmith/Langfuse Cloud):** egresses personal activity data; rejected as default, allowed only as explicit opt-in.
- **Arize Phoenix instead of Langfuse:** lighter (single container) and faster to first trace, but weaker durable cost/usage dashboards; with ample host headroom we chose Langfuse to consolidate trace backend + trajectory store + cost reporting in one tool. Phoenix remains a fallback if the Langfuse footprint becomes a problem.
- **Bespoke Postgres trajectory store alongside Langfuse:** rejected as double-storage; Langfuse traces are the trajectory record (D-OB2).
- **Bespoke trace format:** rejected for OpenTelemetry's portability and tooling.

## Risks / Trade-offs (observability)

- **Self-hosted telemetry is ops to run:** the Langfuse stack (web/worker + Postgres + Clickhouse + Redis + minio) to maintain; accepted for privacy, and `docker compose` handles setup at this scale.
- **Trace storage growth:** Langfuse traces accumulate in Clickhouse; needs a retention/pruning policy (Langfuse supports retention settings).
- **Transient memory pressure:** heavy local builds can already saturate the host and swap; the Langfuse stack adds ~3–4 GB resident, so watch headroom under concurrent build + agent load.

---

