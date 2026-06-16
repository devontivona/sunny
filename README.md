# Sunny

A self-hosted, single-user **personal AI agent** that runs on a home server and acts on its owner's behalf — interacting with the machine, building and running sites, doing research, browsing the web with the owner's credentials, handling email and todos. The primary interface is **iMessage**, with other channels (Telegram, email, CLI, web) added over time.

The architecture is inspired by Nous Research's **Hermes Agent**, re-implemented on a **TypeScript / Vercel** substrate (AI SDK + Chat SDK + Workflow DevKit) with **Claude Opus 4.8**.

## Status

Design phase. The full architecture is captured as an [OpenSpec](https://github.com/Fission-AI/OpenSpec) change:

- **[`openspec/changes/bootstrap-sunny/`](openspec/changes/bootstrap-sunny/)**
  - [`proposal.md`](openspec/changes/bootstrap-sunny/proposal.md) — why, what changes, capabilities, impact
  - [`design.md`](openspec/changes/bootstrap-sunny/design.md) — per-capability design decisions, rejected alternatives, and the post-design review resolutions
  - [`specs/`](openspec/changes/bootstrap-sunny/specs/) — ten capability specs (requirements + scenarios)
  - [`tasks.md`](openspec/changes/bootstrap-sunny/tasks.md) — phased build plan

## Capabilities

| Capability | What it covers |
|---|---|
| `agent-memory` | Files-first memory soul (git-able markdown) + Postgres recall + date-tagged temporal facts |
| `messaging-gateway` | Normalized channel abstraction; iMessage first (Chat SDK + Photon), behind a swappable seam |
| `durable-execution` | Two-tier execution on Workflow DevKit; survives restarts |
| `scheduling` | Self-scheduling cron/one-shot jobs with anti-recursion + cost caps |
| `security-permissions` | Assume-compromise → gate consequences; approval tiers, blocklist, isolation |
| `credentials` | 1Password Service Account; the LLM never sees secret values, only `op://` references |
| `tool-access` | Tool catalog with per-tool risk tiers + credential-reference whitelists |
| `agent-skills` | `SKILL.md` standard; self-authoring + gated installs (`npx skills`) |
| `observability` | OpenTelemetry (self-hosted), trajectories, budget metering, audit log |
| `subagents` | Bounded, least-privilege delegation for context preservation |

## Stack

TypeScript · Node LTS · Vercel AI SDK v6 (`claude-opus-4-8`) · Vercel Chat SDK · Vercel Workflow DevKit (`@workflow/world-postgres`) · Postgres (+ `pgvector` later) · 1Password (`@1password/sdk`) · OpenTelemetry.

---

*Design developed in OpenSpec explore mode. See the `bootstrap-sunny` change for the complete picture.*
