# AGENTS.md — working notes for AI agents editing Sunny

Sunny is a self-hosted personal AI agent (iMessage-first). **Deploy/run details live
in [README.md](README.md) → "Running & deploying"** — this file is just conventions and
gotchas for editing the repo. **Prioritized next steps + openspec cleanup: see
[NEXT_STEPS.md](NEXT_STEPS.md).**

## Commands

```bash
npm run typecheck     # tsc --noEmit (covers src/ + workflows/)
npm run format        # prettier write (src/, server/, plugins/, workflows/)
npm run dev           # nitro dev (local)
npm run build         # nitro build → .output
```

`server/` and `plugins/` are validated by the Nitro build, not by `tsc`.

## Layout

- `src/agent/` — turn loop, dispatcher (serialization/steering), tools (`send_message`,
  `start_job`, `schedule_*`, memory), model + prompt.
- `src/gateway/` — normalized `Gateway` seam, Sendblue driver, conversation store, auth.
- `src/memory/` — files-first memory soul (`~/.sunny/memory/`).
- `src/scheduler/` — schedules table + ~60s ticker.
- `src/db/` — Drizzle schema + client; migrations in `drizzle/`.
- `src/runtime.ts` — memoized startup (DB, migrations, memory, gateway, scheduler).
- `server/` (Nitro routes), `plugins/startup.ts` (starts WDK world + runtime),
  `workflows/` (durable `"use workflow"` jobs).

## Gotchas (hard-won)

- **devbox runs `nitro dev`** (a file watcher) as the live service. **Editing files
  restarts the running service.** That runs migrations + restart-recovery on every edit —
  be deliberate when touching migrations or recovery-affecting code on the box.
- **Never edit an already-applied Drizzle migration** — the migrator silently skips it
  (keys by journal order, not file hash). Add a *new* migration instead.
- **WDK needs the Nitro build.** `"use workflow"` / `"use step"` are no-ops without it.
  Workflows live in `workflows/`; launch with `start()` from `workflow/api`; never call
  `start()` inside workflow context (wrap in a `"use step"`).
- **Anthropic prompts must end with a user message** (no assistant prefill). The recent
  window is insertion-ordered, so trim trailing assistant messages before generating.
- **`send_message` is the only user channel**; the model's plain text is private scratch.
  A telemetered fallback delivers scratch if a turn sends nothing — watch logs for
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
