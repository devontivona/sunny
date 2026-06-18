# AGENTS.md — working notes for AI agents editing Sunny

Sunny is a self-hosted personal AI agent (iMessage-first). **Deploy/run details live
in [README.md](README.md) → "Running & deploying"** — this file is just conventions and
gotchas for editing the repo. Active/planned work lives in OpenSpec changes under
`openspec/changes/`.

## Commands

```bash
npm run typecheck     # tsc --noEmit (covers src/ + workflows/, incl. src/dashboard/)
npm run format        # prettier write (src/, server/, plugins/, workflows/)
npm run dev:unified   # THE dev/serve command: Vite hosts Nitro + WDK (SPA HMR + server
                      #   hot-reload + WDK) on one port. This is what the `sunny` devbox runs.
npm run dashboard:typecheck  # tsc for the React app (app/tsconfig.json)
npm run design:lint   # validate DESIGN.md (repo check; exit 1 on error)
npm run design:export # regenerate the committed app/theme.css from DESIGN.md

# Legacy / fallback (standalone Nitro, no Vite/HMR) — not how the box runs anymore:
npm run dev           # nitro dev          ·   npm run build  # nitro build → .output
npm run dashboard:build  # vite build → app/dist (only the standalone-Nitro serve path)
```

`server/` and `plugins/` are validated by the Nitro build, not by `tsc`.

## Layout

- `src/agent/` — turn loop, dispatcher (serialization/steering), tools (`send_message`,
  `start_job`, `schedule_*`, memory), model + prompt.
- `src/gateway/` — normalized `Gateway` seam, Sendblue driver, conversation store, auth.
- `src/memory/` — files-first memory soul (`~/.sunny/memory/`).
- `src/scheduler/` — schedules table + ~60s ticker.
- `src/db/` — Drizzle schema + client; migrations in `drizzle/`.
- `src/runtime.ts` — memoized startup (DB, migrations, memory, gateway, scheduler). The memo
  is pinned on `globalThis` so Vite's server-module re-eval on a back-end edit doesn't re-run
  startup. `SUNNY_DISABLE_SCHEDULER=1` skips the ticker (for a second instance during cutover).
- `server/` (Nitro routes: `/dashboard/api`, `/webhooks/sendblue`, `/health`),
  `plugins/startup.ts` (starts WDK world + runtime), `workflows/` (durable `"use workflow"` jobs).
- `vite.config.unified.ts` — the unified entry: `[nitro(), react(), tailwindcss(), workflow()]`.
  `nitro.config.ts` omits the `workflow/nitro` module under `NITRO_VITE=1` (the `workflow()`
  Vite plugin supplies it). Root `index.html` → `app/main.tsx` is the SPA entry (served at `/`).
- `app/` — the dashboard React/Vite SPA (its own `tsconfig.json`; `theme.css` generated from
  `DESIGN.md`, committed). `src/dashboard/` — read-only data layer + auth store + session
  signing. `server/routes/dashboard/api/[...].ts` — auth + JSON API; reuses `getRuntime()`
  (db + `gateway.send()`), so the owner approval prompt is an in-process send.

## Gotchas (hard-won)

- **devbox runs `dev:unified`** (Vite hosting Nitro) as the live `sunny` service. Front-end
  edits HMR; back-end (`server/`, `src/`) edits hot-reload the server (re-eval), and run
  migrations on the re-eval — be deliberate touching migrations/recovery code on the box.
  `app/` is excluded from Nitro's watcher; Vite handles its HMR.
- **Never edit an already-applied Drizzle migration** — the migrator silently skips it
  (keys by journal order, not file hash). Add a *new* migration instead.
- **WDK needs the Nitro build.** `"use workflow"` / `"use step"` are no-ops without it.
  Workflows live in `workflows/`; launch with `start()` from `workflow/api`; never call
  `start()` inside workflow context (wrap in a `"use step"`).
- **Anthropic prompts must end with a user message** (no assistant prefill). The recent
  window is insertion-ordered, so trim trailing non-user messages (assistant + tool) before
  generating.
- **`send_message` is the only user channel**; the model's plain text is private scratch.
  Sunny's past replies are reconstructed in history as `send_message` tool-call/result pairs
  (not plain assistant text) so its own track record reinforces "speaking == send_message".
  A telemetered fallback still delivers scratch if a turn sends nothing — watch logs for
  `delivered: 'fallback_text'` (means the elicitation slipped).
- **Postgres** is the dedicated `sunny-postgres` container on `:5544` — *not* the Supabase
  instance on the box. One DB holds messages/FTS/schedules/WDK state (D-DE4).
- **Secrets are env-only** (`.env`, gitignored). Never commit them. Non-secret config is
  `~/.sunny/config.json`.

## Observability

`devbox logs sunny-gateway -f`. Each turn logs `agent:loop: turn { steps, tools, sendCount,
delivered, tokensIn/Out, cachedIn, cacheWriteIn, ms }`. Set `SUNNY_LOG_CONTENT=1` to log message
text (dev only). Prompt caching is on (stable prefix marked `cacheControl: ephemeral`): a
multi-step turn shows `cachedIn > 0` (prefix re-read at ~0.1×); single-step turns show
`cacheWriteIn > 0` (the write).

## Commits

End commit messages with:
`Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
