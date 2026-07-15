## 1. Schema & migration

- [x] 1.1 Add `short_links` and `callback_endpoints` tables to `src/db/schema.ts` per design D8 (unique index on `short_links.url`, pk on `hash`/`token`)
- [x] 1.2 Author migration `drizzle/0014_snny_links_callbacks.sql` + meta snapshot (follow the hand-written precedent; verify `runMigrations()` applies it clean on a fresh and an existing DB)

## 2. Short links

- [x] 2.1 Create `src/gateway/shortlinks.ts`: conservative URL extractor (strip trailing punctuation), dedupe-or-mint (random base58 6-char, collision retry), `rewriteOutboundText(text)` that is a no-op when `SHORT_LINK_BASE_URL` unset and falls back to the original URL on store errors
- [x] 2.2 Wire the rewrite into `SendblueGateway.send()` (`src/gateway/sendblue.ts`) as the last text transformation before `thread.post`/`postMessage`/`sendMediaMessage`, including the group-image URL-append path; confirm persisted history upstream keeps long URLs
- [x] 2.3 Add route `server/routes/s/[hash].get.ts` (model on `media/[token].get.ts`): 302 to stored URL, 404 on unknown/malformed hash
- [x] 2.4 Unit tests: extractor edge cases (trailing `.,;:!?)"'`, parens, multiple URLs, already-short snny URLs), dedupe reuse, collision retry, env-unset no-op, store-failure fallback; route test for 302/404

## 3. Callback hosting

- [x] 3.1 Create `src/gateway/callbacks.ts`: mint (16-byte base64url token, TTL default 30m/max 24h), atomic single-capture transition (conditional UPDATE pending→captured), check/cancel helpers; captured params never logged at info level
- [x] 3.2 Add route `server/routes/cb/[token].get.ts`: capture query params + CF-Connecting-IP/timestamp, render static "done — close this tab" page (no param values echoed), identical non-committal page for unknown/expired/cancelled, second hit → "already completed" without re-capture
- [x] 3.3 On first capture, append the event message ("[oauth_callback] '<label>' hit; params: …") to the originating thread's inbox and call `wakeThread` (reuse the Sendblue webhook wake path in `src/agent/durableRouter.ts`)
- [x] 3.4 Create tool spec `src/agent/tools/oauthCallbackSpec.ts` (zod discriminated `create`/`check`/`cancel`), register in `buildTools()` (`workflows/conversation.ts`) in the trusted-DM-only group, mirror in `src/agent/tools/catalog.ts`
- [x] 3.5 Tests: single-capture race (two concurrent hits → one wake), expiry behavior, cancel-then-hit, tool absent outside owner DM, catalog parity

## 4. Ingress & config

- [x] 4.1 Add `SHORT_LINK_BASE_URL` to `.env.example` with docs; loud doctor/runtime warning when unset in production mode (mirror `DASHBOARD_PUBLIC_URL` handling in `src/runtime.ts`)
- [x] 4.2 Write idempotent `scripts/setup-snny-tunnel.sh`: create-if-missing `snny` tunnel, write `~/.config/sunny/cloudflared-snny.yml` (ingress `snny.ai` + `www.snny.ai` → `http://localhost:8789`), `cloudflared tunnel route dns` for both hosts, install+enable `sunny-snny-tunnel.service` user unit
- [x] 4.3 Add snny ingress check to `scripts/doctor.mjs`: unit active + `https://snny.ai/health` returns 200
- [x] 4.4 Run the setup script on the devbox host (needs `snny.ai` zone live in the Cloudflare account); verify `https://snny.ai/health` from outside

## 5. Verification & deploy

- [x] 5.1 `npm run typecheck` + `npm run test` + local production vite build (CI does not build vite — build before merging, per PR #55 gotcha)
- [x] 5.2 Live smoke after Devon-approved restart: loopback text with a long URL → short link delivered → redirect resolves; persisted transcript shows the long URL
- [x] 5.3 Live smoke callbacks: mint via owner DM, curl `?code=test&state=xyz` → done page + wake event carrying params; second curl → already-completed, no second wake; expired token → non-committal page
- [ ] 5.4 End-to-end dogfood: run a real CLI OAuth flow (e.g. gcloud-style) using a `/cb/` redirect and confirm Sunny completes the exchange hands-free
- [ ] 5.5 Update memory/openspec: sync delta specs to main specs, archive change when done
