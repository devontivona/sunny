# Design — Web Dashboard

## Context

A read-only observability UI for Sunny's internals, served as its **own separate process** (independent of the gateway/durable-execution service). The data already exists (memory files + Postgres); this is a presentation + access-control problem, not a data problem. The aesthetic is deliberately terminal-inspired.

## Decisions

### D-WD1 — One unified server: Vite hosts Nitro + WDK, serving the React SPA + the read-only API with hot reload for both
Sunny runs as a **single process** built by **Vite with the Nitro Vite plugin** (`nitro/vite`) plus the **WDK Vite plugin** (`workflow/vite`): Vite serves the **React SPA** (Tailwind v4 + a few `@base-ui/react` primitives) with HMR, while **Nitro** — hosted inside the same Vite dev server — serves the read-only JSON API (`/dashboard/api/*`), the Sendblue webhook, `/health`, and the WDK workflow routes, with the `"use workflow"`/`"use step"` SWC transform applied by the WDK Vite plugin. The API reads memory files (`loadCore`/`readTopic`) and Postgres via the shared runtime (`getRuntime()` → db). No route mutates Sunny's state except auth session management (D-WD4). The SPA is served at the **root** (`/`); the API lives under `/dashboard/api`.

**Why unified (the "WDK conflict" was a myth).** Earlier revisions assumed a beta "Vite-vs-WDK" incompatibility and so ran the dashboard as a *separate process* (own Express server), then folded its API into a *standalone* Nitro gateway that served a pre-built SPA from disk. Investigation disproved the premise: **Nitro-over-Vite + WDK is the officially documented WDK Vite setup** (`plugins: [nitro(), workflow()]`), shipping a Vite-mode HMR plugin for workflow files. The transform is bundler-agnostic (a Rollup/Vite `transform` hook), so it works identically in Vite mode. Adopting it gives the property the whole change was chasing: **simultaneous front-end and back-end hot reload over the single public URL** — edit a React component → HMR; edit a `server/routes/*` file → server hot-reload; edit a `workflows/*` directive → WDK rebuild. The durable-agent build stays decoupled by construction: the WDK transform runs in the same pipeline, and the SPA needs no separate build step in dev.

**Build & serve.** Dev/serve entry is `vite.config.unified.ts` (`[nitro(), react(), tailwindcss(), workflow()]`), run via `npm run dev:unified` (`NITRO_VITE=1 vite …`). Vite root is the project root so Nitro reads `nitro.config.ts` (serverDir `./server`, `plugins/startup.ts`); the root `index.html` → `/app/main.tsx` is the SPA entry. Two wiring details that matter: (1) the WDK Nitro module must be registered **only** via the `workflow()` Vite plugin, so `nitro.config.ts` omits it when `NITRO_VITE=1` (else it double-applies); (2) the `getRuntime()` singleton is pinned on `globalThis` so Vite's server-module re-eval on a back-end edit does **not** re-run startup (which would leak a scheduler interval + re-init the gateway each edit).

**Deployment.** A single **devbox** service (`sunny`) runs `dev:unified` on `$PORT`, exposed at **`sunny.waywardlane.com`** over its Cloudflare tunnel — the Sendblue webhook, the dashboard, and the durable agent are all one service. The HMR websocket works over the tunnel with `server.hmr = { protocol: 'wss', clientPort: 443 }` + `allowedHosts`. To run a second instance against the shared Postgres during a cutover, isolate its Nitro `buildDir` and set `SUNNY_DISABLE_SCHEDULER=1` so only one instance fires schedules. (A standalone `nitro build` for prod remains available as a fallback, gated on the open WDK prod-build issue.)

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
2. The owner is **DM'd** with the request (device hint) and a **one-time approve link** containing the request secret (the link only ever reaches the owner's DM, so tapping it authenticates as the owner). The notification is sent through the gateway's existing `send()` — an **in-process call** (the dashboard API runs inside the gateway, D-WD1) using a **fixed "dashboard access requested" template** to the **owner only** (it never sends arbitrary text or to arbitrary recipients), rate-limited per requester. Worst-case abuse is a spurious approval prompt to the owner. (When the dashboard ran as its own process this was a narrow localhost-only shared-secret gateway endpoint; folding the API into the gateway makes it a direct call and removes that surface.)
3. On approval, the server marks the request approved and **issues a signed, httpOnly, `SameSite=Lax` session token** bound to that browser; the waiting page advances to the dashboard.
4. Sessions are stored server-side (a `dashboard_sessions` table) with an expiry and are **revocable**; access requests **default-deny on timeout**.

Only the owner can approve (the approve secret reaches only the owner's DM). This is a focused, self-contained cousin of `security-tools-credentials`' crypto DM-pairing (D-SEC2); when that lands it can strengthen/replace this token issuance.

### D-WD5 — Privacy & safety
- Auth is **required before exposure**: if no session secret is configured the dashboard is **disabled (default-deny)** — its API returns 401/unconfigured and serves no private data. A `DASHBOARD_DEV_OPEN=1` escape hatch opens it without a gate for **local development only** (never on a tunnel-exposed host). (When the dashboard was a standalone process this was a localhost-only bind; served by the gateway it can't bind a subset of the port, so unconfigured = disabled is the safe equivalent.)
- **No secrets are ever rendered** (secrets are env-only and not in `config.json`; the config/health view shows only non-secret settings).
- Read-only over Sunny's state: no route mutates memory/messages/schedules. The dashboard's only writes are to its **own auth store** (sessions/access-requests).
- The owner-notify path uses a **fixed, owner-only template** (D-WD4); the dashboard API cannot send arbitrary messages even though it shares the gateway runtime.

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
- **A fully separate dashboard *process* (a prior D-WD1):** the dashboard ran as its own Node/Express service with its own port/tunnel and a localhost-only internal gateway endpoint for owner-notify. Rejected as over-built for a *read-only* view: a third process and a cross-process auth dance. Owner-notify is now an in-process `send()`.
- **Standalone Nitro serving a pre-built SPA from disk (a prior D-WD1):** folded the API into the gateway and served `app/dist` from disk at runtime, with a *separate* Vite dev server for front-end HMR. Rejected because it gives no front-end HMR on the public URL — the prod bundle is what's served there — which defeats fast iteration. Superseded by the unified Vite-hosts-Nitro server (D-WD1), which HMRs both halves on one URL.
- **The assumed "WDK conflicts with Nitro-in-Vite-mode" incompatibility:** the original reason for keeping the builds apart. Disproven — `workflow/vite` + `nitro/vite` is the documented WDK Vite setup and was verified end-to-end (SPA HMR, server-route hot-reload, a durable job draining through the Postgres world, no rebuild loop). This rejection *is* the current design (D-WD1).
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
