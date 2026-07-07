# Sunny

A self-hosted, single-user **personal AI agent** that runs on a home server and acts on its owner's behalf — interacting with the machine, building and running sites, doing research, browsing the web with the owner's credentials, handling email and todos. The primary interface is **iMessage**, with other channels (Telegram, email, CLI, web) added over time.

The architecture is inspired by Nous Research's **Hermes Agent**, re-implemented on a **TypeScript / Vercel** substrate (AI SDK + Chat SDK + Workflow DevKit) with **Claude Sonnet 5**.

## Running & deploying

Sunny runs as **one unified long-lived service** — **Vite hosting Nitro + the Workflow DevKit
(WDK)** — supervised by **devbox** behind a Cloudflare tunnel. The single process serves the
React dashboard SPA (with HMR), the read-only JSON API, the Sendblue webhook, and the durable
agent. The agent core speaks only the normalized `Gateway` seam, with the iMessage transport
(Chat SDK + `chat-adapter-sendblue`) behind it.

### Components

- **Server** — one process from `vite.config.unified.ts` (`[nitro(), react(), tailwindcss(),
  workflow()]`): Vite serves the SPA (`app/`) with HMR, and **Nitro**, hosted inside it, serves
  the read-only JSON API (`/dashboard/api/*`), the Sendblue webhook + `/health` (routes in
  `server/`), and the durable runtime (agent/gateway/memory/scheduler in `src/`, durable
  workflows in `workflows/`). WDK's `"use workflow"` / `"use step"` transform is applied by the
  `workflow()` Vite plugin.
- **Postgres** — a dedicated **`sunny-postgres`** Docker container (pgvector image) on
  `localhost:5544`, db `sunny`. One instance holds the message archive + tsvector FTS,
  schedules, and the WDK world (`workflow` + `graphile_worker` schemas) — consolidated per
  D-DE4. App migrations auto-apply at startup; WDK world tables are created once with
  `npx workflow-postgres-setup`.
- **Observability** — a self-hosted **Langfuse** stack (`deploy/langfuse/docker-compose.yml`),
  Sunny's OTLP trace backend + trace/trajectory store + cost/usage dashboards (D-OB7). All
  services (web + Postgres/Clickhouse/Redis/minio) bind to `127.0.0.1`. The web UI is published
  via **devbox** at `https://langfuse.waywardlane.com`, gated by Langfuse's own login — a
  deliberate egress exception (the UI is password-protected; trace data still lives only on this
  host, no Langfuse Cloud). Sunny exports to `localhost:3010` locally. `devbox rm langfuse` +
  SSH tunnel for a stricter, off-internet posture.
- **Supervisor (home server)** — **`devbox`** runs the unified app as the **`sunny`** systemd
  *user* service (`Restart=always`, linger enabled → starts at boot, survives reboot) and
  publishes it over HTTPS via a Cloudflare tunnel at **`https://sunny.waywardlane.com`**.
- **Secrets** — env-only (`.env` locally / the service environment in prod):
  `ANTHROPIC_API_KEY`, `SENDBLUE_API_KEY`, `SENDBLUE_API_SECRET`, `SENDBLUE_FROM_NUMBER`,
  `SENDBLUE_WEBHOOK_SECRET`, `DATABASE_URL`, `WORKFLOW_TARGET_WORLD`, `WORKFLOW_POSTGRES_URL`,
  and `DASHBOARD_SESSION_SECRET` (+ optional `DASHBOARD_PUBLIC_URL`) for dashboard auth.
  Non-secret settings live in `~/.sunny/config.json`; the memory soul lives under
  `~/.sunny/memory/` (its own git repo).

### First-time setup

```bash
# 1. Dedicated Postgres (isolated from anything else on the box)
docker run -d --name sunny-postgres --restart unless-stopped \
  -e POSTGRES_USER=sunny -e POSTGRES_PASSWORD=<pw> -e POSTGRES_DB=sunny \
  -p 5544:5432 -v sunny-pgdata:/var/lib/postgresql/data pgvector/pgvector:pg16

# 2. Deps + env
npm install
cp .env.example .env   # fill keys; DATABASE_URL=postgres://sunny:<pw>@localhost:5544/sunny
                       # WORKFLOW_TARGET_WORLD=@workflow/world-postgres; WORKFLOW_POSTGRES_URL=$DATABASE_URL
                       # DASHBOARD_SESSION_SECRET=$(openssl rand -base64 32)   # enables the dashboard
# Host CLIs Sunny's bash tool (and the coding skill) lean on: rg, jq, fd, git, gh, tmux.
sudo apt install -y ripgrep jq fd-find gh tmux   # or user-local static binaries in ~/.local/bin —
                       # then make sure the sunny SERVICE's PATH includes them (the devbox cmd's
                       # exported PATH), not just your login shell.

# 3. WDK world tables (idempotent); app migrations apply automatically on first boot
WORKFLOW_POSTGRES_URL="$DATABASE_URL" npx workflow-postgres-setup

# 4. Owner identity — add your iMessage phone/email to ~/.sunny/config.json → owner.identities
#    Family (optional) — add trusted people who get the SAME elevated permissions as the owner:
#      "family": [{ "name": "Kate", "identities": ["+17195551234"] }]
#    Family DMs are fully empowered; group threads are answered only when EVERY participant is
#    owner/family (one outsider silences the whole group). Trust here is the phone/email itself —
#    the same trust class as the owner; tighter lockdown (approvals, pairing) lands with
#    security-permissions. Each family member gets an auto-created profile doc under
#    ~/.sunny/state/memory/people/<id>.md, the per-person analogue of the owner's USER.md.

# 5. (Observability) Stand up self-hosted Langfuse — Sunny's trace backend (D-OB7)
cp deploy/langfuse/.env.example deploy/langfuse/.env   # fill generated secrets + INIT keys (see that file)
# Publish + supervise via devbox (Caddy + Cloudflare tunnel); set NEXTAUTH_URL to the public URL.
devbox add langfuse -d "$PWD/deploy/langfuse" -c "PATH=/snap/bin:/usr/bin:/bin docker compose up" -p 3010
#  → the LANGFUSE_INIT_* keys provision the project headlessly on first boot. Copy that same
#    public/secret pair into the repo-root .env as LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY,
#    and set LANGFUSE_BASE_URL=http://localhost:3010 (Sunny exports from the same host).
#    UI: https://langfuse.waywardlane.com (Langfuse login). Local-only instead? Drop the devbox
#    step, `docker compose up -d`, set NEXTAUTH_URL=http://localhost:3010, SSH-tunnel :3010.
#    Tracing is on when the keys are present; unset → tracing is a no-op.
```

### Run it

- **Launch the unified app:** `npm run dev:unified` — the one command. Vite hosts Nitro + WDK
  on `$PORT`: the SPA (HMR) + server-route hot-reload + WDK rebuilds, all in one process.
- **Operate it via devbox:** the home server runs that command as the **`sunny`** devbox
  service, exposed at `https://sunny.waywardlane.com` over its Cloudflare tunnel (reboot
  survival + crash auto-restart):
  ```bash
  devbox logs sunny -f   #  tail   ·   devbox restart sunny   ·   devbox status sunny
  ```
  HMR works over the tunnel via `server.hmr = { protocol: 'wss', clientPort: 443 }` +
  `allowedHosts` (in `vite.config.unified.ts`). To run a second instance against the shared
  Postgres (e.g. a staged cutover), isolate its Nitro `buildDir` and set
  `SUNNY_DISABLE_SCHEDULER=1` so only one fires schedules.
- **Sendblue:** set the project's **Receive** (inbound) webhook to
  `https://sunny.waywardlane.com/webhooks/sendblue` and the signing secret to
  `SENDBLUE_WEBHOOK_SECRET`. Health check: `/health`.

### Programmatic test channel (drive full turns without iMessage)

A second **loopback** channel for exercising the full pipeline (inbound → router → durable
turn-run → delivery) over HTTP — for tests, scripts, and agent-driven live verification. It runs
**alongside** Sendblue via `MultiChannelGateway` (routes by thread: `loopback:` threads → the test
channel, everything else → iMessage), so enabling it doesn't take iMessage down. Opt-in with
`SUNNY_TEST_CHANNEL=1` + a `SUNNY_TEST_SECRET`; default-off (production is the bare Sendblue
gateway, byte-identical).

```bash
# Deterministic turn (mock model — free, exact reply via the getTurnModel seam):
SUNNY_TEST_SECRET=<s> SUNNY_BASE_URL=https://sunny.waywardlane.com \
  node scripts/test-channel.mjs "ping" --say "pong"
# Real-model turn — prints Sunny's actual reply (drop --say):
SUNNY_TEST_SECRET=<s> SUNNY_BASE_URL=… node scripts/test-channel.mjs "what's a DE1?"
```

Endpoints (header `x-test-secret`): `POST /test/inbound {text, threadId?, modelResponses?}` →
`{cursor}`; `GET /test/outbound?threadId&afterSeq=cursor` → captured replies. Source:
`src/gateway/{loopback,multiChannel}.ts`, `server/routes/test/`.

## Web dashboard (read-only)

A **read-only** terminal-styled web dashboard served by the unified app (above) — a window
into Sunny's innards: memory (SUNNY.md / USER.md / topics), conversation (delivered text **and**
retained scratch) + keyword search, schedules & run history, and activity/health. It is
**observe-only** (no chat, no controls); no route mutates Sunny's state except its own auth.

- **Design system:** authored once in [`DESIGN.md`](DESIGN.md) (Google `@google/design.md`,
  GitHub Dark + monospace TUI). The Tailwind v4 theme is generated from it:
  `npm run design:lint` (repo check) and `npm run design:export` → committed `app/theme.css`.
- **Front end:** React + Vite + Tailwind v4 + a few Base UI primitives, source under `app/`
  (`app/main.tsx` is the SPA entry). Back end: Nitro routes in `server/routes/dashboard/` +
  the read-only data/auth layer in `src/dashboard/`.
- **Auth (iMessage-approval device pairing):** default-deny. An unknown device creates a
  pending request and the **owner is DM'd** a one-time approve link; tapping it lets the
  paired browser mint a signed, httpOnly, revocable session. Set `DASHBOARD_SESSION_SECRET`
  to enable it (the owner prompt is an in-process `send()` with a fixed, owner-only template).
  If it's **unset the dashboard is disabled** (default-deny) unless `DASHBOARD_DEV_OPEN=1`
  (local dev only — never on a tunnel-exposed host).

## Design

The full architecture lives in [`openspec/`](openspec/) — canonical capability specs in
[`openspec/specs/`](openspec/specs/), planned work in [`openspec/changes/`](openspec/changes/),
and the design history (proposals, design decisions, rejected alternatives) under
[`openspec/changes/archive/`](openspec/changes/archive/).

## Capability model — authority × audience

Every agent run (a conversation turn, a delegated subagent, a fired schedule) is governed by two
orthogonal axes. **Authority says what a run may DO** — a set of grants, each mapping to a fixed
tool bundle through one shared builder (`grantTools` in `workflows/runShell.ts`; vocabulary in
`src/agent/audience.ts`). **Audience says how a run may SPEAK** — its reply lane and messaging
verbs derive from who the run is for, never from a grant. Conversation turns hold a root
authority by thread type; spawned runs are endowed a `toolset` preset (`host` — the default —
or `readonly`), and the **effective authority is preset ∩ creator's root** (monotone
attenuation: a spawned run never exceeds its creator, and never holds the spawn grants).

### Authority: what a run may do

| Grant → tools | Group root | Trusted-DM root | Owner-DM root | `readonly` preset | `host` preset |
|---|---|---|---|---|---|
| `memory_read` → read_topic, recall_history | ✅ | ✅ | ✅ | ✅ | ✅ |
| `memory_write` → memory_write ¹ | ✅ | ✅ | ✅ | ❌ | ✅ |
| `file_read` → file_read | ❌ | ✅ | ✅ | ✅ | ✅ |
| `runs_read` → list_runs | ❌ | ✅ | ✅ | ✅ | ✅ |
| `bash` → bash (+ credential injection) | ❌ | ✅ | ✅ | ❌ | ✅ |
| `file_write` → file_write, file_edit | ❌ | ✅ | ✅ | ❌ | ✅ |
| `credentials` → credential_manage | ❌ | ❌ | ✅ | ❌ | ✅ |
| `mcp` → mcp_manage + live MCP tools | ❌ | ❌ | ✅ | ❌ | ✅ |
| `schedule` → schedule_create, cancel_run | ❌ | ✅ | ✅ | never ² | never ² |
| `delegate` → delegate_task | ❌ | ✅ | ✅ | never ² | never ² |

¹ USER.md/SUNNY.md edits additionally require owner scope, inherited from the creator and never
broadened.
² Anti-recursion: no preset contains the spawn grants, so no spawned run can schedule or
delegate.

Internal callers may endow bespoke grant lists (e.g. the nightly-consolidation seed is
memory-only); rows store the resolved grants, so they stay self-describing if presets change.

### Audience: how a run speaks

| Audience kind | Typical run | Reply/deliverable lane | Mid-run channel | `message` (roster fan-out) | send_image |
|---|---|---|---|---|---|
| **live thread** | conversation turn | final text → the thread | translator progress updates | ✅ (trusted DMs; never groups) | ✅ |
| **thread / person** | delivering scheduled run | final text → audience's thread/DM | — | ✅ (own subject refused — no double-send) | ✅ |
| **household** | maintenance schedule | recorded only — nothing sent | — | ✅ (its only voice; any roster member) | ❌ (no single recipient) |
| **parent** | subagent | final text → parent's inbox | `<report>…</report>` blocks | ❌ — speaks only upward, by design | ❌ |

All run profiles carry the full skills index and memory core in their prompt, and every prompt
is capability-gated so a run is never told to use a tool it doesn't hold. Normative statements
live in `openspec/specs/tool-access/spec.md` (authority + messaging), `scheduling/spec.md`, and
`durable-execution/spec.md` — keep this section in sync with those.

These two axes fully determine a run's TOOLS. Two other things vary per run but are not
capability axes: **lifecycle** — the run-supply policy that decides when runs fire and how they
end (the router's perpetual per-turn runs vs. a subagent's spawn-once-report-back vs. the
scheduler's clock; steerability and the failure watchdog ride this axis), and **model/effort** —
a quality-cost dial (`sonnet` default for children, `opus` for scheduled runs) that never
changes what a run may do or say.

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

TypeScript · Node LTS · Vercel AI SDK v7 (`claude-sonnet-5`) · Vercel Chat SDK · Vercel Workflow DevKit (`@workflow/world-postgres`) · Postgres (+ `pgvector` later) · 1Password (`@1password/sdk`) · OpenTelemetry.

---

*Design developed in OpenSpec explore mode. See the `bootstrap-sunny` change for the complete picture.*
