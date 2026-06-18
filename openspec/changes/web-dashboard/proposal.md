## Why

Sunny's state is spread across the memory soul (markdown files), Postgres (messages, schedules, run history), and per-turn runtime metrics. The only window into it today is `devbox logs` and ad-hoc SQL. A small, **read-only web dashboard** gives Devon at-a-glance observability into Sunny's "innards" — what it remembers, what it's said (and privately thought), what it's scheduled, and how it's running — without being a chat interface (Sunny is talked to over iMessage; the dashboard is for *looking*, not *driving*).

## What Changes

Add a **`web-dashboard`** capability: a read-only, terminal-UI-styled **React (Vite) SPA** served by a **separate dashboard service** (its own command, supervised by devbox at `sunny.waywardlane.com`, independent of the gateway), reading from the memory files + Postgres via the dashboard's own read-only JSON API (no new datastore). Its visual identity is authored once in a Google **`DESIGN.md`** (linted; Tailwind v4 theme generated from it) and rendered with **Tailwind** + a few **Base UI** primitives. Pages: **SUNNY.md**, **USER.md**, a **memory browser** (INDEX + topic docs), **conversation** (recent messages + Sunny's retained scratch + keyword search), **schedules & runs**, and **activity & health**. Access is gated by an **iMessage-approval device-pairing** flow: an unknown device triggers Sunny to DM the owner for approval; on approval the device receives a signed token cookie.

## Capabilities

### New Capabilities
- `web-dashboard`: a read-only observability UI for Sunny's internals (memory, conversation, schedules/runs, activity/health), with a terminal aesthetic and iMessage-approval device authentication. Explicitly not a chat/control surface.

## Impact

- **New separate dashboard service:** a small dedicated server (its own command), run under **devbox** with its own Cloudflare tunnel at **`sunny.waywardlane.com`** — independent of the gateway service, so the durable agent + WDK build are untouched by construction.
- **New front-end build + deps:** React + Vite, Tailwind v4 (`@tailwindcss/vite`), `@base-ui/react`, and Google's `@google/design.md` (alpha — pinned) for the design system. The `DESIGN.md` is linted and generates the committed Tailwind theme.
- **Read-only JSON API** served by the dashboard service, with its own read-only access to the existing memory files and Postgres tables. No schema changes except a small **sessions/access-request** store for auth.
- **Reuses the gateway** to DM the owner for access approval — a focused application of the same DM-pairing idea as the planned `security-tools-credentials` crypto DM-pairing (which can later subsume/strengthen it).
- **Security-sensitive:** the dashboard surfaces *private* data (USER.md, messages) and the dashboard service is reachable over its own Cloudflare tunnel (`sunny.waywardlane.com`), so authentication is load-bearing and required before exposure; until a device is approved, access is denied (and the service may bind localhost-only if auth is unconfigured). Read-only — no mutations, so no write/CSRF surface. Running as a separate process also isolates this public surface from the durable agent.
- **Complements, does not duplicate, the `observability` change** (OTel, trajectories, budget meter, audit log). The dashboard is a lightweight view over already-stored state; it can surface the richer observability data once that capability exists.
