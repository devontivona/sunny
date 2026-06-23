> Build plan for the observability change (originally Phase 6 of `bootstrap-sunny`,
> plus the per-run budget cap deferred from scheduling; backups are out of MVP
> scope). D-* decisions are in this change's `design.md`.

- [x] 1 Stand up self-hosted Langfuse (Docker Compose) on the host — OTLP backend, trace/trajectory store, and cost/usage dashboards; no egress (observability R: OTel; D-OB7).
- [x] 2 Redaction-at-source layer — the sink filter that strips secret values and the Service Account token from anything bound for a telemetry sink. **Gate: must be in place before any real data is exported (task 3)**, or secrets leak into Langfuse/Clickhouse (observability R: redaction; D-OB5; ties to credentials D-CR2/D-CR4).
- [x] 3 OpenTelemetry spans (AI SDK telemetry + WDK + gateway/tool) exported over OTLP to Langfuse; tool spans fill in as gated tools land (observability R: OTel; D-OB1).
- [x] 4 Trajectories captured as Langfuse traces — verify turns/jobs produce inspectable, replayable traces; no separate trajectory store (observability R: trajectories; D-OB2).

> Budget enforcement, the redacted audit log, and insights move to the `observability-2` change (its tasks 1–3).
