# Sunny

A self-hosted, single-user **personal AI agent** that runs on a home server and acts on its owner's behalf — interacting with the machine, building and running sites, doing research, browsing the web with the owner's credentials, handling email and todos. The primary interface is **iMessage**, with other channels (Telegram, email, CLI, web) added over time.

The architecture is inspired by Nous Research's **Hermes Agent**, re-implemented on a **TypeScript / Vercel** substrate (AI SDK + Chat SDK + Workflow DevKit) with **Claude Opus 4.8**.

## Status

**Phase 0–1 implemented** — the walking skeleton to a live iMessage loop (Milestone B:
"text Sunny → get a real Opus reply"). Memory, durability, scheduling, security, skills,
observability, and subagents are later phases. See `openspec/changes/bootstrap-sunny/tasks.md`.

## Running (Phase 0–1 skeleton)

Sunny runs foreground in dev with env-var secrets (Postgres / 1Password / systemd are
later phases). The agent core speaks only the normalized `Gateway` seam; the iMessage
transport (Chat SDK + the `chat-adapter-sendblue` adapter) sits behind it.

```bash
npm install
cp .env.example .env          # fill in ANTHROPIC_API_KEY (+ Sendblue creds for live iMessage)
npm run dev                   # tsx watch; or: npm start
```

### Live setup (what you must provision)

1. **Anthropic key** — set `ANTHROPIC_API_KEY` in `.env` (Claude Opus 4.8, D-PS3).
2. **Sendblue account** — from the Sendblue dashboard, set `SENDBLUE_API_KEY`,
   `SENDBLUE_API_SECRET`, and your Sendblue number `SENDBLUE_FROM_NUMBER` in `.env`. Set
   `SENDBLUE_WEBHOOK_SECRET` to verify inbound deliveries (recommended).
3. **Owner identity** — add your iMessage phone/email to `~/.sunny/config.json` →
   `owner.identities` (the gateway authorizes inbound senders; D-MG6 / task 2.4).
4. **Public webhook** — Sunny listens on `:8787/webhooks/sendblue`. In dev, expose it with
   the `devbox` skill and set that public URL as the **Receive** (inbound) webhook in the
   Sendblue dashboard (task 1.3). In prod the home server's own reachable endpoint replaces
   it (D-PS6). Health check: `:8787/health`.

`~/.sunny/config.json` (non-secret settings, D-PS5) is seeded with defaults on first run.

### Milestones

- **Milestone A (transport echo)** — `SUNNY_ECHO=1 npm start`: text Sunny, it echoes back.
  Proves the transport round-trip with no LLM.
- **Milestone B (live agent)** — `npm start` (default): text Sunny, get a real Opus reply.
  Sunny speaks only via the `send_message` tool; its reasoning is private (D-MG8).

## Design

The full architecture is captured as an [OpenSpec](https://github.com/Fission-AI/OpenSpec) change:

- **[`openspec/changes/bootstrap-sunny/`](openspec/changes/bootstrap-sunny/)**
  - [`proposal.md`](openspec/changes/bootstrap-sunny/proposal.md) — why, what changes, capabilities, impact
  - [`design.md`](openspec/changes/bootstrap-sunny/design.md) — per-capability design decisions, rejected alternatives, and the post-design review resolutions
  - [`specs/`](openspec/changes/bootstrap-sunny/specs/) — ten capability specs (requirements + scenarios)
  - [`tasks.md`](openspec/changes/bootstrap-sunny/tasks.md) — phased build plan

## Capabilities

| Capability | What it covers |
|---|---|
| `agent-memory` | Files-first memory soul (git-able markdown) + Postgres recall + date-tagged temporal facts |
| `messaging-gateway` | Normalized channel abstraction; iMessage first (Chat SDK + Sendblue), behind a swappable seam |
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
