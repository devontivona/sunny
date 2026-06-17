> Build plan for the observability change (originally Phase 6 of `bootstrap-sunny`,
> plus the cross-cutting backups task and the per-run budget cap deferred from
> scheduling). D-* decisions are in this change's `design.md`.

- [ ] 1 OpenTelemetry spans (AI SDK telemetry + WDK + gateway/tool) to a self-hosted collector; no egress (observability R: OTel; D-OB1).
- [ ] 2 Per-run trajectories persisted to Postgres (observability R: trajectories; D-OB2).
- [ ] 3 Cost/token budget meter with enforcement: per-run cap + autonomous rate limit (the per-run cap deferred from `scheduling`) → stop + notify; **plus a global daily/monthly spend ceiling + kill switch and an agent-loop step cap** covering all activity (observability R: budget metering, global circuit-breaker; D-OB3; R8).
- [ ] 4 Redacted audit log of tool + secret access (wires security D-SEC7); redaction across all sinks (observability R: audit log, redaction; D-OB4/5).
- [ ] 5 Insights summary deliverable over the gateway (observability R: insights; D-OB6).
- [ ] 6 Backups (cross-cutting): scheduled `git` commits of the single `~/.sunny/` repo (memory + skills); periodic `pg_dump` of the local Postgres DB (off-host copy).
