> Build plan for the web-dashboard change. A read-only React/Vite dashboard on the
> existing Nitro app, themed from a Google `DESIGN.md`. D-WD* decisions are in this
> change's `design.md`. **Design system first, then the website.**

## 1. Design system (DESIGN.md) — before any UI

- [ ] 1.1 Author `DESIGN.md` at the repo root in the `@google/design.md` format: YAML token front-matter (Tokyo Night colors, monospace typography, spacing, radii) + the prose sections the format expects (Overview, Colors, Typography, …) (D-WD2/7).
- [ ] 1.2 Add `@google/design.md` (pinned — it's alpha) and wire the linter as a repo check: `npx @google/design.md lint DESIGN.md` (exit 1 on error) via an npm script (and CI later) (D-WD7).
- [ ] 1.3 Export the Tailwind v4 theme and commit it: `npx @google/design.md export --format css-tailwind DESIGN.md > app/theme.css` (committed so a CLI/schema change can't silently break the build) (D-WD7).

## 2. Front-end scaffold & serving (decoupled Vite build)

- [ ] 2.1 Add deps: `react`/`react-dom` (19), `vite@^7`, `@vitejs/plugin-react`, `tailwindcss` + `@tailwindcss/vite` (v4), `@base-ui/react`. Source under `app/`; `index.html` entry; `app/index.css` = `@import "tailwindcss"` + the generated `theme.css` (D-WD1).
- [ ] 2.2 Serving (D-WD1): `vite build` → `public/dashboard/`; serve via Nitro `publicAssets` at base `/dashboard` (CLI-mode Nitro unchanged). Dev: `vite dev` (HMR) beside `nitro dev` with a `/dashboard/api` (+ `/webhooks`) proxy; replicate the `.swc`/build-cache watch-ignore. Client routing via hash routes or a small SPA-fallback so deep links don't 404.
- [ ] 2.3 Shared React layout: サニー masthead, Tailwind theme (from DESIGN.md), monospace, a hyperlink component (renders human-readable links, never raw URLs); **home = vertical menu**, **child pages = horizontal side-scrolling top menu** (D-WD2). At most a couple of Base UI primitives.

## 3. Read-only data API (Nitro JSON routes)

- [ ] 3.1 JSON endpoints under `server/routes/dashboard/api/` via `getRuntime()` (read-only, non-secret only): memory (core + topic list/doc), conversation (recent per thread + retained scratch + keyword `recall`), schedules + runs, activity (per-turn metrics from message-payload metadata) + health (service/Postgres/scheduler/gateway + unprocessed-inbound count) (D-WD3/5).

## 4. Authentication (iMessage-approval device pairing)

- [ ] 4.1 `dashboard_sessions` + `access_requests` store (Drizzle migration): signed httpOnly session token, device hint, expiry, revoked; pending request id + one-time secret + status (D-WD4).
- [ ] 4.2 Auth gate on the SPA shell **and** the `dashboard/api/*` routes: valid session → allow; otherwise create a pending request, return 401/waiting state (D-WD4).
- [ ] 4.3 Owner approval: Sunny DMs the owner (gateway) with device details + a one-time approve link; the approve route validates the secret, marks approved, issues the session token; default-deny on timeout (D-WD4).
- [ ] 4.4 Session expiry + revocation; bind localhost-only when auth is unconfigured (D-WD4/5).

## 5. Pages (React views consuming the API)

- [ ] 5.1 SUNNY.md and USER.md views (sanitized markdown render) (D-WD3).
- [ ] 5.2 Memory browser: INDEX + topic list, each topic openable (D-WD3).
- [ ] 5.3 Conversation: recent messages per thread (role/time/delivered + retained scratch) + keyword search (D-WD3).
- [ ] 5.4 Schedules & runs (next run, active, status, output/error) (D-WD3).
- [ ] 5.5 Activity & health (tokens/cache/delivered/steps + health panel) (D-WD3/5).

## 6. Verify

- [ ] 6.1 `@google/design.md lint DESIGN.md` passes; the committed `theme.css` matches the DESIGN.md.
- [ ] 6.2 No route mutates Sunny state except auth; no secret is rendered anywhere; markdown is sanitized (D-WD5/6).
- [ ] 6.3 End-to-end: unknown device → owner approval DM → token → pages render; revocation forces re-pairing; unconfigured-auth binds localhost. Confirm the decoupled Vite build doesn't perturb the `workflow/nitro` build.
