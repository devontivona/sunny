## Why

Sunny's state is spread across the memory soul (markdown files), Postgres (messages, schedules, run history), and per-turn runtime metrics. The only window into it today is `devbox logs` and ad-hoc SQL. A small, **read-only web dashboard** gives Devon at-a-glance observability into Sunny's "innards" — what it remembers, what it's said (and privately thought), what it's scheduled, and how it's running — without being a chat interface (Sunny is talked to over iMessage; the dashboard is for *looking*, not *driving*).

## What Changes

Add a **`web-dashboard`** capability: a read-only, terminal-UI-styled **React (Vite) SPA** served from a **single unified server** — **Vite hosting Nitro + WDK** (`nitro/vite` + `workflow/vite`) — that serves the SPA (at root, with HMR), the read-only JSON API (`/dashboard/api`), the Sendblue webhook, and the durable agent in one process with hot reload for both front end and back end. Reads from the memory files + Postgres via read-only JSON routes (no new datastore). Its visual identity is authored once in a Google **`DESIGN.md`** (linted; Tailwind v4 theme generated from it) and rendered with **Tailwind** + a few **Base UI** primitives. Pages: **SUNNY.md**, **USER.md**, a **memory browser** (INDEX + topic docs), **conversation** (recent messages + Sunny's retained scratch + keyword search), **schedules & runs**, and **activity & health**. Access is gated by an **iMessage-approval device-pairing** flow: an unknown device triggers Sunny to DM the owner for approval; on approval the device receives a signed token cookie.

## Capabilities

### New Capabilities
- `web-dashboard`: a read-only observability UI for Sunny's internals (memory, conversation, schedules/runs, activity/health), with a terminal aesthetic and iMessage-approval device authentication. Explicitly not a chat/control surface.

## Impact

- **One unified server (no new service):** the dev/serve entry becomes **Vite hosting Nitro + WDK** (`vite.config.unified.ts`: `[nitro(), react(), tailwindcss(), workflow()]`, run as the `sunny` devbox service). It serves the SPA, the read-only API, the Sendblue webhook, and the durable agent in one process — replacing the prior standalone-`nitro dev` gateway. This delivers **simultaneous front-end and back-end hot reload over the single public URL**, which the prior "serve a pre-built bundle from a Nitro route" approach could not.
- **New front-end build + deps:** React + Vite, Tailwind v4 (`@tailwindcss/vite`), `@base-ui/react`, and Google's `@google/design.md` (alpha — pinned). The `DESIGN.md` is linted and generates the committed Tailwind theme.
- **Read-only JSON API** as Nitro routes, reading the existing memory files and Postgres via the shared runtime. No schema changes except a small **sessions/access-request** store for auth. Two small enabling changes: `getRuntime()` is pinned on `globalThis` (so back-end HMR doesn't re-run startup), and `nitro.config.ts` omits the WDK module under `NITRO_VITE=1` (the `workflow()` Vite plugin supplies it).
- **Reuses the gateway** to DM the owner for access approval (an in-process `send()` with a fixed, owner-only template) — a focused application of the same DM-pairing idea as the planned `security-tools-credentials` crypto DM-pairing (which can later subsume/strengthen it).
- **Security-sensitive:** the dashboard surfaces *private* data (USER.md, messages) and is reachable wherever the gateway is exposed, so authentication is load-bearing and required before exposure; until a device is approved, access is denied, and with no session secret configured the dashboard is **disabled** (default-deny). Read-only — no mutations, so no write/CSRF surface. The owner-notify path can only send a **fixed owner-only template**, so even sharing the gateway runtime it can't be used to message arbitrarily as Sunny.
- **Complements, does not duplicate, the `observability` change** (OTel, trajectories, budget meter, audit log). The dashboard is a lightweight view over already-stored state; it can surface the richer observability data once that capability exists.
