# Design — Web Dashboard

## Context

A read-only observability UI for Sunny's internals, served by the existing Nitro app. The data already exists (memory files + Postgres); this is a presentation + access-control problem, not a data problem. The aesthetic is deliberately terminal-inspired.

## Decisions

### D-WD1 — React (Vite) SPA + read-only Nitro JSON API
The dashboard is a **React single-page app built with Vite**, styled with **Tailwind CSS v4** (`@tailwindcss/vite`, CSS-first `@theme`) and a few **Base UI** (`@base-ui/react`, the maintained MUI headless lib) unstyled primitives (at most dialog / menu / tabs — we need very few). Data comes from **read-only Nitro JSON API routes** under `server/routes/dashboard/api/` that read the memory files (`loadCore`/`readTopic`) and Postgres (conversation store + schedules) via the existing `getRuntime()` seam; the React app fetches and renders them. No route mutates Sunny's state except auth session management (D-WD4).

**Serving — keep the durable build isolated (decision).** Nitro 3 offers a Vite-plugin mode, but the WDK/durable-execution build (`workflow/nitro`) is load-bearing and beta, so v1 does **not** switch Nitro into Vite mode. Instead: `vite build` emits the SPA to `public/dashboard/`, served by the existing CLI-mode Nitro via `publicAssets` (base `/dashboard`); in dev the Vite dev server (HMR) runs alongside `nitro dev` and proxies `/dashboard/api` to it. This fully decouples the front-end from the `workflow/nitro` rollup transform, sidestepping the beta SPA-fallback / transform-ordering pitfalls. Client routing uses hash routes (or a small Nitro SPA-fallback route) so deep links don't 404. A later consolidation to single-server Vite-plugin mode (`@workflow/nitro/vite`'s `workflow()` + `nitro()` + `react()`) is possible once proven — not required for v1.

### D-WD2 — Visual language (terminal UI)
- **Masthead:** the Katakana name for Sunny — **サニー** — at the top of every page.
- **Palette:** a popular VS Code dark theme — **Tokyo Night** (e.g. bg `#1a1b26`, fg `#c0caf5`, accents blue `#7aa2f7` / cyan `#7dcfff` / green `#9ece6a` / magenta `#bb9af7` / red `#f7768e`). Exact tokens are an implementation detail captured in one CSS file.
- **Type:** a monospace/coder font stack (e.g. `ui-monospace, "JetBrains Mono", "Fira Code", monospace`).
- **Links:** always render **hyperlinks, never raw URLs** — link text is human-readable; the href is hidden behind it.
- **Navigation:** the **home page** lists the menu **vertically** (an enumerated index, terminal-directory feel); **child pages** show the menu as a **horizontal, side-scrolling** bar pinned at the top.
- **Source of truth:** the palette, type, spacing, and radii are defined once in a `DESIGN.md` (Tokyo Night tokens) and the Tailwind v4 `@theme` is **generated** from it — see D-WD7. One shared React layout consumes the generated theme; pages are routed views inside it.

### D-WD3 — Pages and their data sources
| Page | Source |
|---|---|
| `SUNNY.md` | `loadCore().sunny` (rendered markdown) |
| `USER.md` | `loadCore().user` |
| Memory browser | `INDEX.md` + the `topics/` dir (list + render each topic doc) |
| Conversation | `messages` table — recent per thread; show role, time, delivered text, **and the retained scratch** (from the `UIMessage` payload); keyword search via `recall()` |
| Schedules & runs | `schedules` (kind/spec/next-run/active/label) + `schedule_runs` (fired, status, output, error) |
| Activity & health | per-turn metrics aggregated from message-payload metadata (`usage{in,out,cached,cacheWrite}`, `delivered`, `steps`) + a service/Postgres/scheduler/gateway health panel (incl. unprocessed-inbound count) |

Each page fetches JSON from its `dashboard/api/*` route; the API returns raw markdown/text and the React app renders it with a **sanitizing** markdown renderer (memory/message content is untrusted-ish — avoid stored-HTML/script injection).

### D-WD4 — Authentication: iMessage-approval device pairing
The dashboard exposes private data over a public tunnel, so access is **default-deny** and pairing happens through the channel Sunny already owns:

1. A request from an **unrecognized device** (no valid session cookie) creates a pending **access request** (random id + secret; captured device hint: user-agent, coarse IP/time) and shows a "waiting for approval" page that sets a pending cookie and polls/refreshes.
2. Sunny **DMs the owner** (via the gateway) with the request details and a **one-time approve link** containing the request secret (the link is only ever sent to the owner's DM, so tapping it authenticates as the owner). Optionally the owner can reply with an approve code.
3. On approval, the server marks the request approved and **issues a signed, httpOnly, `SameSite=Lax` session token** bound to that browser; the waiting page advances to the dashboard.
4. Sessions are stored server-side (a `dashboard_sessions` table) with an expiry and are **revocable**; access requests **default-deny on timeout**.

Only the owner can approve (the approve secret reaches only the owner's DM). This is a focused, self-contained cousin of `security-tools-credentials`' crypto DM-pairing (D-SEC2); when that lands it can strengthen/replace this token issuance.

### D-WD5 — Privacy & safety
- Auth is **required before exposure**; if auth is unconfigured the server binds **localhost-only** rather than serving private data over the tunnel.
- **No secrets are ever rendered** (secrets are env-only and not in `config.json`; the config/health view shows only non-secret settings).
- Read-only: no route mutates state, so there is no write/CSRF surface; the only state-changing actions are auth (approve/revoke), which are owner-gated and use one-time secrets.

### D-WD6 — Strictly observability, not control
No chat box, no "send message," no schedule/job triggers, no memory edits. The dashboard only *reflects* Sunny's state. (If control is ever wanted, it's a separate change with its own gating.)

### D-WD7 — Design system as a Google DESIGN.md (tokens → Tailwind)
The visual identity is authored once in a **`DESIGN.md`** at the repo root using Google's **`@google/design.md`** format (YAML token front-matter — Tokyo Night colors, monospace typography, spacing, radii — plus the prose sections the format expects: Overview, Colors, Typography, …). The Tailwind v4 theme is **generated** from it, not hand-written:

```
npx @google/design.md export --format css-tailwind DESIGN.md > app/theme.css   # v4 @theme block
npx @google/design.md lint DESIGN.md                                            # 9 rules; exit 1 on error
```

`theme.css` is imported alongside `@import "tailwindcss"`; the generated `@theme` tokens become Tailwind utilities (`bg-*`, `font-*`). DESIGN.md authoring → **lint** → **export** happens **before** building pages, and `lint` runs as a repo check so the design system stays valid. Caveats: `@google/design.md` is **alpha** (v0.3.x), so the token schema may shift — we **pin the version** and **commit the generated `theme.css`** so a CLI/schema change can't silently break the build; the export is a one-way generate step (DESIGN.md is the source of truth).

## Rejected alternatives
- **Server-rendered HTML, no SPA (the prior D-WD1):** simpler/safer, but React + Vite is faster to build the multi-page UI and gives a better component story (Base UI); chosen for velocity. Read-only + the auth gate keep the added client surface low-risk.
- **Nitro Vite-plugin mode (single server) for v1:** nicer (one server, unified dev), but it forces the WDK into beta Vite-mode with real SPA-fallback/transform-ordering pitfalls against the load-bearing durable build. Deferred; v1 keeps CLI-mode Nitro + a decoupled Vite build (D-WD1).
- **Hand-written CSS / ad-hoc theme:** rejected in favor of a single DESIGN.md source of truth that lints + generates the Tailwind theme (D-WD7).
- **No auth / localhost-only only:** the owner wants to view remotely over the tunnel; localhost-only is the *fallback* when auth is unconfigured, not the design.
- **Password / basic-auth:** another secret to manage and phishable; the iMessage-approval flow reuses Sunny's existing trusted channel and is nicer.
- **A chat/control surface:** explicitly out of scope — Sunny is driven over iMessage; the dashboard is for looking.

## Risks / Trade-offs
- **Auth is load-bearing:** private data over a public tunnel means a flaw exposes Devon's personal life. Mitigations: default-deny, owner-only approval via DM-delivered one-time secret, httpOnly signed sessions, expiry + revocation, localhost fallback.
- **Session token theft** (cookie exfiltration) would grant read access until revoked/expired — bounded by short-ish expiry + revocation.
- **Approval-DM is the trust anchor:** if the owner's iMessage is compromised, dashboard access is too — same trust root as the rest of Sunny.
- **Markdown rendering** of memory/messages must be sanitized to avoid stored-HTML/script injection in the dashboard.
- **Beta/alpha dependencies:** `@google/design.md` is alpha and Nitro 3 + Vite + `workflow/nitro` are beta. Mitigations: pin versions, commit the generated `theme.css`, and keep the Vite build decoupled from the WDK build (D-WD1) so front-end churn can't destabilize the durable core.
