# Design — Web Dashboard

## Context

A read-only observability UI for Sunny's internals, served by the existing Nitro app. The data already exists (memory files + Postgres); this is a presentation + access-control problem, not a data problem. The aesthetic is deliberately terminal-inspired.

## Decisions

### D-WD1 — Server-rendered, read-only, on the existing Nitro app
Pages are server-rendered HTML from Nitro routes under `server/routes/dashboard/`, reading the memory files (`loadCore`/`readTopic`) and Postgres (the conversation store + schedules) through the existing `getRuntime()` seam. **No SPA framework and minimal/no client JS** — it matches the terminal aesthetic, keeps the surface small, and there is nothing to mutate. Any interactivity (e.g. the side-scrolling menu, search box) is plain HTML/CSS + a sprinkle of vanilla JS. Rendering is read-only: no endpoint mutates Sunny's state.

### D-WD2 — Visual language (terminal UI)
- **Masthead:** the Katakana name for Sunny — **サニー** — at the top of every page.
- **Palette:** a popular VS Code dark theme — **Tokyo Night** (e.g. bg `#1a1b26`, fg `#c0caf5`, accents blue `#7aa2f7` / cyan `#7dcfff` / green `#9ece6a` / magenta `#bb9af7` / red `#f7768e`). Exact tokens are an implementation detail captured in one CSS file.
- **Type:** a monospace/coder font stack (e.g. `ui-monospace, "JetBrains Mono", "Fira Code", monospace`).
- **Links:** always render **hyperlinks, never raw URLs** — link text is human-readable; the href is hidden behind it.
- **Navigation:** the **home page** lists the menu **vertically** (an enumerated index, terminal-directory feel); **child pages** show the menu as a **horizontal, side-scrolling** bar pinned at the top.
- One shared layout + CSS; pages are content slotted into it.

### D-WD3 — Pages and their data sources
| Page | Source |
|---|---|
| `SUNNY.md` | `loadCore().sunny` (rendered markdown) |
| `USER.md` | `loadCore().user` |
| Memory browser | `INDEX.md` + the `topics/` dir (list + render each topic doc) |
| Conversation | `messages` table — recent per thread; show role, time, delivered text, **and the retained scratch** (from the `UIMessage` payload); keyword search via `recall()` |
| Schedules & runs | `schedules` (kind/spec/next-run/active/label) + `schedule_runs` (fired, status, output, error) |
| Activity & health | per-turn metrics aggregated from message-payload metadata (`usage{in,out,cached,cacheWrite}`, `delivered`, `steps`) + a service/Postgres/scheduler/gateway health panel (incl. unprocessed-inbound count) |

Markdown is rendered to HTML server-side (a small, dependency-light renderer) and sanitized.

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

## Rejected alternatives
- **SPA (React/Next):** overkill for read-only pages, heavier surface, and against the terminal aesthetic. Server-rendered HTML + CSS is simpler and safer.
- **No auth / localhost-only only:** the owner wants to view remotely over the tunnel; localhost-only is the *fallback* when auth is unconfigured, not the design.
- **Password / basic-auth:** another secret to manage and phishable; the iMessage-approval flow reuses Sunny's existing trusted channel and is nicer.
- **A chat/control surface:** explicitly out of scope — Sunny is driven over iMessage; the dashboard is for looking.

## Risks / Trade-offs
- **Auth is load-bearing:** private data over a public tunnel means a flaw exposes Devon's personal life. Mitigations: default-deny, owner-only approval via DM-delivered one-time secret, httpOnly signed sessions, expiry + revocation, localhost fallback.
- **Session token theft** (cookie exfiltration) would grant read access until revoked/expired — bounded by short-ish expiry + revocation.
- **Approval-DM is the trust anchor:** if the owner's iMessage is compromised, dashboard access is too — same trust root as the rest of Sunny.
- **Markdown rendering** of memory/messages must be sanitized to avoid stored-HTML/script injection in the dashboard.
