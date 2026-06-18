## Why

Sunny's state is spread across the memory soul (markdown files), Postgres (messages, schedules, run history), and per-turn runtime metrics. The only window into it today is `devbox logs` and ad-hoc SQL. A small, **read-only web dashboard** gives Devon at-a-glance observability into Sunny's "innards" — what it remembers, what it's said (and privately thought), what it's scheduled, and how it's running — without being a chat interface (Sunny is talked to over iMessage; the dashboard is for *looking*, not *driving*).

## What Changes

Add a **`web-dashboard`** capability: a read-only, terminal-UI-styled **React (Vite) SPA** served by the existing Nitro app, reading from the memory files + Postgres via read-only Nitro JSON API routes (no new datastore). Its visual identity is authored once in a Google **`DESIGN.md`** (linted; Tailwind v4 theme generated from it) and rendered with **Tailwind** + a few **Base UI** primitives. Pages: **SUNNY.md**, **USER.md**, a **memory browser** (INDEX + topic docs), **conversation** (recent messages + Sunny's retained scratch + keyword search), **schedules & runs**, and **activity & health**. Access is gated by an **iMessage-approval device-pairing** flow: an unknown device triggers Sunny to DM the owner for approval; on approval the device receives a signed token cookie.

## Capabilities

### New Capabilities
- `web-dashboard`: a read-only observability UI for Sunny's internals (memory, conversation, schedules/runs, activity/health), with a terminal aesthetic and iMessage-approval device authentication. Explicitly not a chat/control surface.

## Impact

- **New front-end build + deps:** React + Vite, Tailwind v4 (`@tailwindcss/vite`), `@base-ui/react`, and Google's `@google/design.md` (alpha — pinned) for the design system. The SPA is built by Vite into `public/dashboard/` and served by the existing **CLI-mode** Nitro via `publicAssets` (the WDK build is left untouched; Nitro Vite-plugin mode is a deferred consolidation). The `DESIGN.md` is linted and generates the committed Tailwind theme.
- **New Nitro JSON API routes** under `server/routes/dashboard/api/` plus read-only queries over the existing memory files and Postgres tables. No schema changes except a small **sessions/access-request** store for auth.
- **Reuses the gateway** to DM the owner for access approval — a focused application of the same DM-pairing idea as the planned `security-tools-credentials` crypto DM-pairing (which can later subsume/strengthen it).
- **Security-sensitive:** the dashboard surfaces *private* data (USER.md, messages) and the server is reachable over the Cloudflare tunnel, so authentication is load-bearing and required before exposure; until a device is approved, access is denied (and the server may bind localhost-only if auth is unconfigured). Read-only — no mutations, so no write/CSRF surface.
- **Complements, does not duplicate, the `observability` change** (OTel, trajectories, budget meter, audit log). The dashboard is a lightweight view over already-stored state; it can surface the richer observability data once that capability exists.
