# Sunny

A self-hosted, single-user **personal AI agent** that runs on a home server and acts on its owner's behalf — interacting with the machine, building and running sites, doing research, browsing the web with the owner's credentials, handling email and todos. The primary interface is **iMessage**, with other channels (Telegram, email, CLI, web) added over time.

The architecture is inspired by Nous Research's **Hermes Agent**, re-implemented on a **TypeScript / Vercel** substrate (AI SDK + Chat SDK + Workflow DevKit) with **Claude Opus 4.8**.

## Running & deploying

Sunny is a long-lived service — a Nitro-built Node server plus a Postgres database. Nitro
is the build layer that compiles Workflow DevKit's `"use workflow"` / `"use step"`
directives; the agent core speaks only the normalized `Gateway` seam, with the iMessage
transport (Chat SDK + `chat-adapter-sendblue`) behind it.

### Components

- **Server** — Nitro app: routes in `server/` (Sendblue webhook + `/health`),
  `plugins/startup.ts` starts the WDK Postgres world then the runtime, durable workflows
  in `workflows/`, agent/gateway/memory/scheduler in `src/`.
- **Postgres** — a dedicated **`sunny-postgres`** Docker container (pgvector image) on
  `localhost:5544`, db `sunny`. One instance holds the message archive + tsvector FTS,
  schedules, and the WDK world (`workflow` + `graphile_worker` schemas) — consolidated per
  D-DE4. App migrations auto-apply at startup; WDK world tables are created once with
  `npx workflow-postgres-setup`.
- **Supervisor (home server)** — **`devbox`** runs the server as a systemd *user* service
  (`devbox@sunny-gateway`, `Restart=always`, linger enabled → starts at boot, survives
  reboot) and publishes it over HTTPS via a Cloudflare tunnel at
  `https://sunny-gateway.waywardlane.com`.
- **Secrets** — env-only (`.env` locally / the service environment in prod):
  `ANTHROPIC_API_KEY`, `SENDBLUE_API_KEY`, `SENDBLUE_API_SECRET`, `SENDBLUE_FROM_NUMBER`,
  `SENDBLUE_WEBHOOK_SECRET`, `DATABASE_URL`, `WORKFLOW_TARGET_WORLD`,
  `WORKFLOW_POSTGRES_URL`. Non-secret settings live in `~/.sunny/config.json`; the memory
  soul lives under `~/.sunny/memory/` (its own git repo).

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

# 3. WDK world tables (idempotent); app migrations apply automatically on first boot
WORKFLOW_POSTGRES_URL="$DATABASE_URL" npx workflow-postgres-setup

# 4. Owner identity — add your iMessage phone/email to ~/.sunny/config.json → owner.identities
```

### Run it

- **Local dev:** `npm run dev` (Nitro dev server; honors `$PORT`).
- **Home server (current):** supervised by devbox —
  ```bash
  devbox add sunny-gateway --dir <repo> --cmd '<node-bin-on-PATH> npm run dev' --port 8787
  devbox logs sunny-gateway -f   # tail   ·   devbox restart sunny-gateway   ·   devbox status sunny-gateway
  ```
  devbox gives reboot survival + crash auto-restart (systemd `Restart=always` + linger).
- **Sendblue:** set the project's **Receive** (inbound) webhook to
  `https://sunny-gateway.waywardlane.com/webhooks/sendblue` and the signing secret to
  `SENDBLUE_WEBHOOK_SECRET`. Health check: `/health`.

## Web dashboard (read-only)

A **read-only** terminal-styled web dashboard (`web-dashboard` change) gives a window
into Sunny's innards — memory (SUNNY.md / USER.md / topics), conversation (delivered
text **and** retained scratch) + keyword search, schedules & run history, and
activity/health. It is **observe-only** (no chat, no controls).

Architecture: **one unified server**. Sunny runs as **Vite hosting Nitro + WDK**
(`vite.config.unified.ts` → `[nitro(), react(), tailwindcss(), workflow()]`): Vite serves the
React SPA (in `app/`, at the root path) with HMR, and Nitro — hosted inside the same Vite
server — serves the read-only JSON API (`/dashboard/api/*`), the Sendblue webhook, `/health`,
and the durable agent, with WDK's `"use workflow"`/`"use step"` transform applied by the
`workflow()` Vite plugin. So the agent, the webhook, and the dashboard are a single process
with **hot reload for both front end and back end** over one public URL.

- **Design system:** authored once in [`DESIGN.md`](DESIGN.md) (Google `@google/design.md`
  format, Tokyo Night + monospace). The Tailwind v4 theme is generated from it:
  `npm run design:lint` (repo check) and `npm run design:export` → committed `app/theme.css`.
- **Front end:** React + Vite + Tailwind v4 + a few Base UI primitives, source under `app/`;
  the root `index.html` → `app/main.tsx` is the SPA entry.
- **Back end:** Nitro routes under `server/routes/` (`/dashboard/api`, `/webhooks/sendblue`,
  `/health`) + `src/dashboard/` (data access + auth store). Reads memory files + Postgres via
  the shared runtime; the only writes are its own auth tables.
- **Auth (iMessage-approval device pairing):** default-deny. An unknown device creates a
  pending request and the **owner is DM'd** a one-time approve link; tapping it lets the
  paired browser mint a signed, httpOnly, revocable session. Set `DASHBOARD_SESSION_SECRET`
  to enable it (the owner prompt is an in-process `send()` with a fixed, owner-only template).
  If it's **unset the dashboard is disabled** (default-deny) unless `DASHBOARD_DEV_OPEN=1`
  (local dev only — never on a tunnel-exposed host).

### Run & deploy

- **Local dev:** `npm run dev:unified` (`NITRO_VITE=1 vite --config vite.config.unified.ts`) —
  one server with SPA HMR + server-route hot-reload + WDK. Honors `$PORT`.
- **Home server:** the single **`sunny`** devbox service runs `dev:unified`, exposed at
  `https://sunny.waywardlane.com`; the Sendblue **Receive** webhook points to
  `https://sunny.waywardlane.com/webhooks/sendblue`. Set `DASHBOARD_SESSION_SECRET` (+
  `DASHBOARD_PUBLIC_URL`) in its env. The HMR websocket runs over the tunnel via
  `server.hmr = { protocol: 'wss', clientPort: 443 }` + `allowedHosts` (in the Vite config).
  ```bash
  devbox logs sunny -f   # tail   ·   devbox restart sunny   ·   devbox status sunny
  ```
  To run a second instance against the shared Postgres (e.g. a staged cutover), isolate its
  Nitro `buildDir` and set `SUNNY_DISABLE_SCHEDULER=1` so only one fires schedules.

## Design

The full architecture lives in [`openspec/`](openspec/) — canonical capability specs in
[`openspec/specs/`](openspec/specs/), planned work in [`openspec/changes/`](openspec/changes/),
and the design history (proposals, design decisions, rejected alternatives) under
[`openspec/changes/archive/`](openspec/changes/archive/).

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
