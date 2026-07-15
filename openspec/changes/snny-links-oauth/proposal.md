## Why

Sunny texts URLs constantly (media links, dashboard approve links, hosted sites, research links), and long URLs render poorly in iMessage bubbles. Devon has registered `snny.ai` as a dedicated short domain. Separately, CLI OAuth flows are a recurring papercut: Sunny runs a CLI on the devbox, the CLI prints an auth URL whose redirect lands on `http://localhost:<port>`, and Devon — completing the flow on his phone — has to manually copy the failed localhost redirect URL back into the chat (e.g. the 2026-06-30 Google OAuth flow via `localhost:36061`, and the 2026-07-13 Gmail re-auth). Both problems are solved by giving Sunny a small public HTTP surface on `snny.ai`, served by the existing gateway process and exposed through a dedicated Cloudflare tunnel — independent of the devbox service.

## What Changes

- **Short links**: every http(s) URL in every outbound message is automatically rewritten to `https://snny.ai/s/<6-char-hash>` at the single delivery chokepoint (`SendblueGateway.send()`), backed by a new `short_links` Postgres table and a public `GET /s/[hash]` 302-redirect route. The model never sees or manages short links.
- **OAuth callback hosting**: a new agent tool lets Sunny mint a public callback URL (`https://snny.ai/cb/<id>`) on demand. When the URL is hit, the gateway captures the full request (query params, e.g. `code`/`state`), renders a friendly "you can close this tab" page, and wakes Sunny with a new turn in the originating thread carrying the captured parameters — so Sunny can complete the CLI token exchange itself instead of asking Devon to paste URLs back.
- **Dedicated `snny.ai` ingress**: a new named cloudflared tunnel (own config, credentials, and systemd user unit, owned by this project) routes `snny.ai` directly to the Sunny Nitro server on `localhost:8789`. No dependency on the devbox service, its Caddy router, or its `devbox` tunnel — only on `cloudflared` itself, which is architecturally required for self-hosting.
- New env var (`SHORT_LINK_BASE_URL` or similar) configures the public short-link origin; absence disables shortening (dev/test-safe), mirroring the `DASHBOARD_PUBLIC_URL` pattern.

## Capabilities

### New Capabilities
- `short-links`: outbound URL shortening — hash minting, persistence, delivery-time rewrite rules (what gets shortened, idempotency, group-image URL appends), and the public redirect route.
- `callback-hosting`: agent-mintable public callback endpoints — the `oauth_callback` tool surface, capture-and-wake semantics, callback lifecycle (pending/hit/expired), and the security posture of an ungated public route.
- `snny-ingress`: the dedicated Cloudflare tunnel that exposes the gateway on `snny.ai` — setup, systemd unit, config ownership, and doctor checks.

### Modified Capabilities
- `messaging-gateway`: outbound sends now pass through a URL-shortening rewrite before hitting the Sendblue adapter (including the group-thread image-URL append path).
- `tool-access`: a new trusted-DM tool (`oauth_callback`) joins the tool surface and catalog.

## Impact

- **DB**: new `short_links` and `callback_endpoints` tables in `src/db/schema.ts` + migration `drizzle/0014_*.sql` (auto-applies on boot via `runMigrations()`).
- **Gateway**: rewrite hook in `src/gateway/sendblue.ts` (the `text` finalization path, ~lines 234–320); new Nitro routes `server/routes/s/[hash].get.ts` and `server/routes/cb/[id].get.ts` (modeled on `media/[token].get.ts`).
- **Agent**: new tool spec `src/agent/tools/oauthCallbackSpec.ts`, registered in `workflows/conversation.ts` `buildTools()` and mirrored in `src/agent/tools/catalog.ts`; callback hits reuse the inbox-append + `wakeThread` pattern from the Sendblue webhook path.
- **Host**: new cloudflared tunnel + systemd user unit + Cloudflare DNS route for `snny.ai` (same CF account as waywardlane.com); setup script/docs in-repo. Deploy requires a devbox-approved restart.
- **Non-goals**: no click analytics, no link expiry (short links live forever), no changes to the existing MCP OAuth infra (`src/mcp/oauth.ts` stays as-is; `callback-hosting` is a parallel generic mechanism, not a refactor of it).
