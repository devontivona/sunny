> Build plan for the web-dashboard change. A read-only React/Vite dashboard run as a
> **separate service** (its own command, supervised by devbox at `sunny.waywardlane.com`,
> independent of the gateway), themed from a Google `DESIGN.md`. D-WD* decisions are in
> this change's `design.md`. **Design system first, then the website.**

## 1. Design system (DESIGN.md) — before any UI

- [x] 1.1 Author `DESIGN.md` at the repo root in the `@google/design.md` format: YAML token front-matter (Tokyo Night colors, monospace typography, spacing, radii) + the prose sections the format expects (Overview, Colors, Typography, …) (D-WD2/7).
- [x] 1.2 Add `@google/design.md` (pinned — it's alpha) and wire the linter as a repo check: `npx @google/design.md lint DESIGN.md` (exit 1 on error) via an npm script (and CI later) (D-WD7).
- [x] 1.3 Export the Tailwind v4 theme and commit it: `npx @google/design.md export --format css-tailwind DESIGN.md > app/theme.css` (committed so a CLI/schema change can't silently break the build) (D-WD7).

## 2. Dashboard serving (one unified Vite-hosts-Nitro server)

- [x] 2.1 Serve the SPA + read-only API + webhook + durable agent from ONE process — Vite hosting Nitro + WDK (`vite.config.unified.ts`: `[nitro(), react(), tailwindcss(), workflow()]`). SPA at root `/`, API under `/dashboard/api`, with read-only access to Postgres + `~/.sunny/memory/` via the shared runtime. Hot reload for both front end and back end on one URL (D-WD1).
- [x] 2.2 Add front-end deps: `react`/`react-dom` (19), `vite@^7`, `@vitejs/plugin-react`, `tailwindcss` + `@tailwindcss/vite` (v4), `@base-ui/react`. Source under `app/`; `index.html` entry; `app/index.css` = `@import "tailwindcss"` + the generated `theme.css` (D-WD1).
- [x] 2.3 Serve (D-WD1): Vite's dev server serves the SPA with HMR; Nitro (hosted by Vite) serves the API/webhook; the WDK Vite plugin transforms `"use workflow"`/`"use step"`. Client routing via hash routes so deep links don't 404. The HMR websocket works over the Cloudflare tunnel (`hmr.protocol: 'wss'`, `clientPort: 443`, `allowedHosts`).
- [x] 2.4 Shared React layout: サニー masthead, Tailwind theme (from DESIGN.md), monospace, a hyperlink component (renders human-readable links, never raw URLs); **home = vertical menu**, **child pages = horizontal side-scrolling top menu** (D-WD2). At most a couple of Base UI primitives.

## 3. Read-only data API (gateway Nitro routes under /dashboard/api)

- [x] 3.1 JSON endpoints under `/dashboard/api/*`, reading Postgres + memory files via the gateway's shared runtime (read-only, non-secret only): memory (core + topic list/doc), conversation (recent per thread + retained scratch + keyword `recall`), schedules + runs, activity (per-turn metrics from message-payload metadata) + health (service/Postgres/scheduler/gateway + unprocessed-inbound count) (D-WD3/5).

## 4. Authentication (iMessage-approval device pairing)

- [x] 4.1 `dashboard_sessions` + `access_requests` store (Drizzle migration): signed httpOnly session token, device hint, expiry, revoked; pending request id + one-time secret + status (D-WD4).
- [x] 4.2 Auth gate on the SPA shell **and** the `dashboard/api/*` routes: valid session → allow; otherwise create a pending request, return 401/waiting state (D-WD4).
- [x] 4.3 Owner-notify via an **in-process** `gateway.send()` (dashboard API runs inside the gateway): rate-limited, sends ONLY the fixed "dashboard access requested" template (request id + device hint + approve link) to the owner's DM thread — never arbitrary text/recipients (D-WD4).
- [x] 4.4 Owner approval flow: the owner taps the one-time approve link; the approve route validates the secret, marks the request approved, and the polling browser exchanges its pending cookie for the signed session token; default-deny on timeout (D-WD4).
- [x] 4.5 Session expiry + revocation; when no session secret is configured the dashboard is **disabled (default-deny)** — `DASHBOARD_DEV_OPEN=1` is the local-dev-only open escape hatch (D-WD4/5).

## 5. Pages (React views consuming the API)

- [x] 5.1 SUNNY.md and USER.md views (sanitized markdown render) (D-WD3).
- [x] 5.2 Memory browser: INDEX + topic list, each topic openable (D-WD3).
- [x] 5.3 Conversation: recent messages per thread (role/time/delivered + retained scratch) + keyword search (D-WD3).
- [x] 5.4 Schedules & runs (next run, active, status, output/error) (D-WD3).
- [x] 5.5 Activity & health (tokens/cache/delivered/steps + health panel) (D-WD3/5).

## 6. Deploy & verify

- [x] 6.1 Deploy as the single `sunny` devbox service running `dev:unified` (`DASHBOARD_SESSION_SECRET` + `DASHBOARD_PUBLIC_URL` in env) at `sunny.waywardlane.com`; the Sendblue webhook points to `sunny.waywardlane.com/webhooks/sendblue`. Replaces the standalone `sunny-gateway` service (D-WD1).
- [x] 6.2 `@google/design.md lint DESIGN.md` passes; the committed `theme.css` matches the DESIGN.md.
- [x] 6.3 No route mutates Sunny state except auth; no secret is rendered anywhere; markdown is sanitized (D-WD5/6).
- [x] 6.4 End-to-end verified on the unified server over the tunnel: SPA + API + webhook + WDK on one URL; FE HMR (incl. the wss HMR socket through Cloudflare) + BE route hot-reload; a durable job drains through the Postgres world; no rebuild loop; a BE edit does not re-run startup (globalThis runtime singleton). Auth: unknown device → owner approval DM → session → pages render; revocation forces re-pairing; no session secret ⇒ dashboard disabled (default-deny).
