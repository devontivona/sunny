## Context

Devon registered `snny.ai` (same Cloudflare account as waywardlane.com). Two features ride on it:

1. **Short links** — every URL Sunny texts out becomes `https://snny.ai/s/<6-char-hash>` so iMessage bubbles stay readable.
2. **Callback hosting** — Sunny mints `https://snny.ai/cb/<token>` endpoints for CLI OAuth flows, replacing the "text a localhost-redirect auth URL, ask Devon to paste the failed redirect back" loop (seen 2026-06-30 gcloud/Drive re-auth via `localhost:36061`, and 2026-07-13 Gmail re-auth).

Current state that shapes the design:

- **One transport chokepoint exists.** `deliver()` (`workflows/runShell.ts:359`) is the conversation-lane seam, but a handful of sends bypass it (undeliverable-person notice `runShell.ts:439`, router retry notices `durableRouter.ts:386,439`, runtime echoes). The true narrowest point is `SendblueGateway.send()` (`src/gateway/sendblue.ts`, text finalization ~lines 234–320), which also appends plaintext public media URLs for group image sends.
- **The webhook-wake pattern exists.** Inbound Sendblue webhooks append to the thread inbox and call `wakeThread` (`src/agent/durableRouter.ts:169–175`). The MCP OAuth callback route (`server/routes/dashboard/api/[...].ts:250–293`) shows the ungated public callback shape (CSRF state lookup, trusts only `CF-Connecting-IP`, GET renders HTML).
- **Unauthenticated param-addressed GET routes exist** (`server/routes/media/[token].get.ts`) — the template for `/s/[hash]` and `/cb/[token]`.
- **DB**: Postgres + Drizzle, schema in `src/db/schema.ts`, migrations `drizzle/0000–0013`, auto-applied on boot by `runMigrations()`.
- **Host**: the Sunny process listens on `localhost:8789` and is currently public only as `sunny.waywardlane.com` via the devbox-owned tunnel. Devon explicitly wants `snny.ai` exposure to depend on cloudflared only, not on devbox.

## Goals / Non-Goals

**Goals:**
- All outbound URLs shortened automatically at one seam; the model never sees or manages short links.
- A trusted-DM `oauth_callback` tool: mint → user taps → callback captured → Sunny wakes with the params and finishes the flow itself.
- `snny.ai` served by the existing Sunny gateway process through a project-owned cloudflared tunnel; zero devbox coupling.

**Non-Goals:**
- Click analytics, link expiry, custom slugs, QR codes.
- Refactoring the existing MCP OAuth infra (`src/mcp/oauth.ts` and its callback route stay untouched; `callback-hosting` is a parallel generic mechanism).
- Acting as a real OAuth *server* (no token issuing, no PKCE exchange in the generic tool — Sunny just captures redirect params and hands them to whatever CLI is waiting).
- Shortening URLs in dashboard UI or anywhere other than outbound message text.

## Decisions

**D1 — Rewrite at `SendblueGateway.send()`, not `deliver()`.**
`deliver()` misses the direct `gateway.send` callers (notifications, router notices) and the group-image URL append that happens *inside* the driver. Rewriting on the driver's local `text` variable right before `thread.post`/`postMessage`/`sendMediaMessage` covers every lane with one function call and keeps persisted history holding the original URLs for free (persistence happens upstream). The rewrite helper lives in `src/gateway/shortlinks.ts` (URL regex extraction → dedupe lookup → mint on miss → replace), is a no-op when `SHORT_LINK_BASE_URL` is unset, and swallows store errors (deliver long URL rather than fail the send). Loopback/test channels get the same no-op by leaving the env unset in tests.
*Alternative considered:* rewriting in `deliver()` — cleaner conceptually but leaks long URLs through the bypass lanes; both seams would be needed anyway.

**D2 — Dedupe by exact long-URL string; random 6-char base58 hash; rows live forever.**
A unique index on `url` makes re-sends reuse the hash (spec requirement) and a unique index on `hash` makes collision-retry trivial (~57 bits of space; collisions vanishingly rare at personal scale). No counters, no encoding schemes. Base58-style alphabet (no `0OIl`) since these get read aloud/retyped occasionally.

**D3 — `/s/` and `/cb/` are plain Nitro routes on the existing server, host-agnostic.**
New files `server/routes/s/[hash].get.ts` and `server/routes/cb/[token].get.ts`, modeled on `media/[token].get.ts`. They'll technically also answer on `sunny.waywardlane.com` — harmless, no host gating. Conversely the dashboard becomes reachable on `snny.ai`; it's already session-gated, so no new exposure beyond what `sunny.waywardlane.com` has today. `SHORT_LINK_BASE_URL=https://snny.ai` is only used for *generating* URLs.

**D4 — Dedicated `snny` cloudflared tunnel owned by this repo.**
A second named tunnel (`snny`) with its own credentials JSON and config at `~/.config/sunny/cloudflared-snny.yml`, ingress `snny.ai` + `www.snny.ai` → `http://localhost:8789`, run by a `sunny-snny-tunnel.service` systemd user unit. DNS routed via `cloudflared tunnel route dns snny snny.ai`. Setup script `scripts/setup-snny-tunnel.sh` (idempotent: create-if-missing tunnel, rewrite config, route DNS, install+enable unit); doctor gains a check (unit active + `https://snny.ai/health` 200). This satisfies "depends on cloudflared, not devbox": multiple tunnels per account/host are fully supported, and devbox's `~/.cloudflared/config.yml` is never touched.
*Alternatives considered:* adding an ingress rule to the devbox tunnel (couples to devbox, its `setup` rewrites that config); extending devbox with custom-domain support (bigger blast radius, still a dependency).

**D5 — Callback capture wakes the originating thread via the existing inbox + `wakeThread` path.**
The `cb` route validates the token against `callback_endpoints` (status `pending`, unexpired), atomically transitions `pending → captured` (single-capture via a conditional UPDATE), stores the query params, renders the static "done" page, then appends a system-style event message to the originating thread ("[oauth_callback] '<label>' was hit; params: …") and calls `wakeThread`. This is exactly how Sendblue webhooks wake runs today — no new machinery, works whether or not a run is in flight. If Sunny is mid-turn waiting via the `wait` tool, the event folds in as a steer.
*Alternative considered:* a durable blocking wait inside the tool call — rejected per the WDK multi-turn hook gotchas and because it ties up the turn.

**D6 — One `oauth_callback` tool with `create` / `check` / `cancel` actions.**
Spec at `src/agent/tools/oauthCallbackSpec.ts` (zod discriminated actions), wired in `buildTools()` (`workflows/conversation.ts:347`) in the trusted-DM-only group, mirrored in `catalog.ts`. Tokens are 22-char base64url from 16 random bytes (unguessable; the route is ungated). Default TTL 30 min, max 24 h. `check` covers the race where the callback fires while no run can wake (process restarting).

**D7 — Captured params go into model context deliberately.**
The whole point is that Sunny forwards `code`/`state` to the CLI's waiting localhost listener — the same values Devon pastes into the chat today. OAuth authorization codes are single-use and short-lived; the wake event carries them, but the `/cb/` response page never echoes them and they're excluded from info-level logs. This matches the existing "secrets never *silently* enter context" posture: it's owner-initiated, per-flow, and visible in the thread.

**D8 — Schema.**
```
short_links:        hash (pk, 6 chars), url (text, unique), created_at
callback_endpoints: token (pk), thread_id, label, status (pending|captured|cancelled|expired),
                    ttl_expires_at, created_at, captured_at, captured_params (jsonb), captured_meta (jsonb)
```
One migration `drizzle/0014_snny_links_callbacks.sql`, hand-authored following existing precedent, auto-applied on boot.

## Risks / Trade-offs

- **[Link rot if the host dies]** Short links only resolve while Devon's box serves snny.ai → accepted for a personal single-host system; the original URL is always in Sunny's history if forensics are needed.
- **[iMessage link previews change]** Previews will render for `snny.ai` instead of the destination site (no unfurl of the target). → Accepted; the readability win is the point. If a specific send needs a rich preview later, an exclusion knob can be added.
- **[Rewrite regex mangles edge-case text]** URLs with trailing punctuation, parens, or inside quotes. → Use a conservative extractor (match `https?://` runs, strip trailing `.,;:!?)"'`), unit-test against real outbound samples from the messages table.
- **[Ungated public routes invite scanning]** `/s/` 404s leak nothing; `/cb/` renders one identical page for unknown/expired/cancelled tokens and only transitions state on an exact 128-bit token match. Cloudflare fronts both (no direct origin exposure).
- **[Prompt-injection minting callbacks]** The tool is trusted-DM-only, and a hostile page can't hit it; worst case Sunny mints a useless endpoint. Captured params wake only the *originating* thread.
- **[Second tunnel drift]** Two cloudflared processes on one host → both are tiny; the setup script + doctor check keep the snny one visible. Devbox `setup` re-runs can't clobber it (separate config path).
- **[Env not set in prod after deploy]** Shortening silently off. → doctor warns when `SHORT_LINK_BASE_URL` is unset in production mode (same loud-warning pattern as `DASHBOARD_PUBLIC_URL` in `runtime.ts:127`).

## Migration Plan

1. Land code + migration (auto-applies on boot). No data backfill; existing sent URLs stay long.
2. Host setup (one-time, before or after merge): run `scripts/setup-snny-tunnel.sh` — requires the `snny.ai` zone active in the Cloudflare account and `cloudflared tunnel login` cert able to see it. Verify `https://snny.ai/health`.
3. Add `SHORT_LINK_BASE_URL=https://snny.ai` to `.env`.
4. Deploy = devbox-managed restart (**Devon's call, never automatic**).
5. Smoke: text a long URL over the loopback/test channel with the env set → short link received → redirect works; mint a callback, curl it with `?code=test` → done page + wake event in thread; re-curl → "already completed", no second wake.
6. Rollback: unset `SHORT_LINK_BASE_URL` (shortening off instantly), stop `sunny-snny-tunnel.service` (domain dark); tables are additive and inert.

## Open Questions

- Should the access-request dashboard approve link (contains a one-time secret) be excluded from shortening for trust-appearance reasons, or is `snny.ai` trusted enough? Default: shorten it like everything else; revisit if it feels off.
- `www.snny.ai` — include in ingress + DNS from day one (cheap) or apex only? Default: include.
