## Why

The **observability** change delivers the visibility foundation (self-hosted Langfuse, OTel spans, trajectories, redaction). It deliberately turns tracing *on* without yet *bounding* spend or *recording* access. To actually trust autonomy, Sunny still needs to enforce cost caps (not just report them), keep a redacted audit trail of tool/secret access, and surface usage where Devon already is (the messaging gateway). This change adds that governance-and-insights layer on top of part 1.

## What Changes

Extend the **observability** capability with: a cost/token budget meter with **enforcement** in the agent loop (per-run cap — the one `scheduling` defers here — plus a global daily/monthly spend ceiling, kill switch, and agent-loop step cap), stopping and notifying rather than overspending; a **redacted audit log** of every tool invocation and secret access, reusing part 1's redaction layer; and an **insights summary** delivered over the gateway (on request or on a schedule), with deep exploration left to Langfuse's dashboards.

## Capabilities

### Modified Capabilities
- **observability** — adds in-agent budget metering + global circuit-breaker (enforcement), a redacted audit log of tool/secret access, and a gateway-delivered insights summary. Builds on the tracing/trajectory/redaction foundation from the `observability` change.

## Impact

Builds on the **observability** change (part 1: Langfuse, spans, trajectories, redaction). Depends on **security-tools-credentials**: the audit log records the tool/secret-access events that only exist once `tool-access` + `credentials` are built, and the on-request insights path is exposed as a gated usage tool under `tool-access`. Enforcement picks up the per-run cost cap and autonomous rate limit that `scheduling`'s "Bounded autonomous dispatch" requirement points to, plus the always-on budget pressure from `agent-memory`.
