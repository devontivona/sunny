## Why

Devon wants a personal AI agent ("Sunny") that runs locally on his home server and acts on his behalf: interacting with the machine, building websites, doing research, browsing the web with his credentials, answering email, and handling todos. The primary interface is iMessage, with other channels (CLI, email, Telegram, web chat) added over time.

The architecture is inspired by Nous Research's **Hermes Agent** (its memory model, self-authored skills, durable gateway, cron self-scheduling, bounded delegation, and layered security), but re-implemented on a **TypeScript / Vercel** substrate (AI SDK v6 with Claude Opus, Workflow DevKit for durability) rather than forking Hermes' Python.

This change **bootstraps Sunny's foundation** — enough to be a live, durable, self-scheduling iMessage agent with a files-first memory. It covers four capabilities (`agent-memory`, `messaging-gateway`, `durable-execution`, `scheduling`) plus the project skeleton. The remaining capabilities (`security-permissions`, `credentials`, `tool-access`, `agent-skills`, `observability`, `subagents`) were split into their own focused changes once the foundation was "bootstrapped."

## What Changes

- Establish the overall Sunny architecture and substrate decision (TS/Vercel, files-first, self-hosted, direct host access guarded by approval tiers — the latter specified in the `security-tools-credentials` change).
- **`agent-memory`**: a layered memory architecture whose *soul* (capped always-on markdown core + on-demand topic docs) stays in git-able files, with message recall (Postgres tsvector full-text + optional local `pgvector` semantic upgrade) in the DB tier, a nightly self-scheduled consolidation job, and date-tagged facts for temporal reasoning. Managed memory services rejected for a single-user, privacy-sensitive, self-hosted agent.
- **`messaging-gateway`**: a channel abstraction where the agent core speaks one normalized interface and each channel is a pluggable driver. iMessage first, via the Vercel Chat SDK with the published `chat-adapter-sendblue` transport, behind a thin custom `Gateway` seam. Sunny owns its own conversation store. An explicit `send_message` output model (raw model text is private — D-MG8), and a **turn-grained transcript** that persists one `UIMessage` per turn and retains Sunny's working-context scratch across turns (D-MG9).
- **`durable-execution`**: a two-tier execution model on Vercel Workflow DevKit (`@workflow/world-postgres`). Tier-1 conversational turns are idempotent per inbound message; Tier-2 long/async jobs run as durable `DurableAgent` workflows that survive crashes/reboots and resume mid-agent. No user-facing token streaming. Persist messages once on completion. One Postgres for messages, FTS, vectors, and workflow state.
- **`scheduling`**: Sunny schedules itself — persisted one-shot/interval/cron schedules that survive restarts and dispatch as Tier-2 durable jobs; an anti-recursion guard; gateway delivery of run output; and bounded per-tick dispatch. (Per-run cost/token budget caps live in the `observability` change.)
- **Project skeleton & conventions**: repo layout, runtime (Node LTS + TS), the `~/.sunny/` contract, model wiring, config/secrets, and home-server deployment (Nitro app supervised by devbox; Cloudflare tunnel).

## Capabilities

### New Capabilities
- `agent-memory`: How Sunny stores, recalls, and curates what it knows — the always-on core, on-demand topic docs, keyword/semantic recall over message history, and self-scheduled consolidation.
- `messaging-gateway`: How Sunny sends and receives messages — a normalized gateway the agent core speaks, pluggable channel drivers (iMessage via Chat SDK + Sendblue first), capability flags, sender authorization, a self-owned turn-grained conversation store, and an explicit `send_message` output model.
- `durable-execution`: How Sunny survives restarts — idempotent in-process turns plus durable Workflow DevKit jobs (`DurableAgent`), on one Postgres that also holds messages, FTS, and vectors.
- `scheduling`: How Sunny schedules itself — persisted one-shot/interval/cron schedules dispatched as durable jobs, with an anti-recursion guard, gateway delivery, and bounded dispatch.

The remaining capabilities are specified in their own changes: **`security-tools-credentials`** (security-permissions + credentials + tool-access), **`skills`** (agent-skills), **`observability`**, and **`subagents`**.

## Impact

- **New project** (`sunny`), greenfield. No existing code or specs affected.
- Stack: TypeScript, Vercel AI SDK v6 (`@ai-sdk/anthropic`, Claude Opus 4.8), Vercel Chat SDK (`chat` + `chat-adapter-sendblue`), Vercel Workflow DevKit (`@workflow/world-postgres`, `@workflow/ai`), Nitro, Postgres (+ `pgvector` later). Memory soul as files under `~/.sunny/memory/`.
- The DB tier (messages + tsvector FTS, pgvector embeddings later, and Workflow DevKit execution/job state) is consolidated in one Postgres instance; the memory soul stays as git-able markdown files.
- Adds an operational dependency on a running Postgres instance and a long-lived worker process (WDK's Postgres world is not serverless — appropriate for an always-on home server). Deployed as a Nitro app supervised by devbox (systemd user service + Cloudflare tunnel).
- Establishes the always-on token budget every message-handling run pays (with prompt caching on the stable prefix — a conditional optimization, not a blanket cost win; see Review Resolutions R2).
- Security posture, credentials, real tools, skills, observability, and subagents are defined in the split-out changes.
