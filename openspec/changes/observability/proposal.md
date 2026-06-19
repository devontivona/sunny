## Why

Sunny acts autonomously (scheduled runs, durable jobs, tool use) and spends real money on Opus. Today there are only structured logs. To trust autonomy, Devon needs to see what Sunny did and why (traces/trajectories), bound spend (a real budget meter + kill switch), and keep a redacted audit trail of tool + secret access. This change also picks up the **per-run cost/token budget cap** that the scheduling capability deliberately defers here.

## What Changes

Add the **observability** capability (originally Phase 6 of `bootstrap-sunny`): OpenTelemetry spans to a self-hosted collector (no egress); per-run trajectories persisted to Postgres; a cost/token budget meter with enforcement (per-run cap — the one scheduling defers — plus a global daily/monthly ceiling, kill switch, and agent-loop step cap); a redacted audit log of tool/secret access; and an insights summary delivered over the gateway. Also folds in the cross-cutting backups task.

## Capabilities

### New Capabilities
- **observability** — OpenTelemetry (self-hosted), per-run trajectories, budget metering + global circuit-breaker, redacted audit log, insights summary.

## Impact

Builds on the bootstrapped foundation and complements **security-permissions** (the audit log records tool/secret access; budget caps bound autonomous runs). The per-run cost cap here is what `scheduling`'s "Bounded autonomous dispatch" requirement points to.
