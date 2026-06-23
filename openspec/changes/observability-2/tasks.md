> Build plan for the observability-2 change (budget enforcement + audit log +
> insights), layered on the `observability` change (part 1: Langfuse, spans,
> trajectories, redaction). D-* decisions are in this change's `design.md`.

- [ ] 1 Cost/token budget meter with enforcement: per-run cap + autonomous rate limit (the per-run cap deferred from `scheduling`) → stop + notify; **plus a global daily/monthly spend ceiling + kill switch and an agent-loop step cap** covering all activity. Enforcement is in-agent; Langfuse provides cost/usage reporting. **Independent of security-tools-credentials — can start as soon as part 1 lands** (observability R: budget metering, global circuit-breaker; D-OB3; R8).
- [ ] 2 Redacted audit log of tool + secret access (wires security D-SEC7), reusing part 1's redaction layer. **Depends on `tool-access` + `credentials` (security-tools-credentials)** — the tools/secret-access events it records (observability R: audit log; D-OB4).
- [ ] 3 Insights summary delivered over the gateway, sourced from Langfuse usage data; deep exploration lives in Langfuse dashboards. Scheduled (push) path needs only gateway + scheduling; **on-request path rides on `tool-access`** (security-tools-credentials), not `agent-skills` (observability R: insights; D-OB6).
