## ADDED Requirements

### Requirement: Outbound URLs are shortened at the transport seam
Every http(s) URL contained in outbound message text SHALL be rewritten to `<SHORT_LINK_BASE_URL>/s/<hash>` immediately before the text is handed to the message transport, at the single transport chokepoint (`SendblueGateway.send()`), covering every outbound lane: conversational replies, proactive/scheduled sends, notifications, and the group-thread image-URL append. The rewrite SHALL be invisible to the model — the model composes and sees only original long URLs; short links never appear in model context or the persisted transcript's model-facing history.

Rewrite rules:
- A URL whose origin is already the short-link origin SHALL NOT be re-shortened.
- The same long URL SHALL resolve to the same existing hash on subsequent sends (dedupe by exact URL string).
- When `SHORT_LINK_BASE_URL` is unset, shortening SHALL be disabled and text passes through unchanged (dev/test-safe, mirroring `DASHBOARD_PUBLIC_URL` handling).
- If short-link persistence fails at send time, the send SHALL proceed with the original URL rather than failing the delivery.

#### Scenario: Reply containing a long URL
- **WHEN** Sunny sends a message containing `https://accounts.google.com/o/oauth2/auth?scope=...&redirect_uri=...` (300+ chars)
- **THEN** the recipient receives the message with that URL replaced by `https://snny.ai/s/<6-char-hash>`
- **AND** visiting the short link redirects to the original URL

#### Scenario: Same URL sent twice
- **WHEN** the same long URL appears in two different outbound messages
- **THEN** both messages carry the same short link (one `short_links` row, not two)

#### Scenario: Short-link origin is not re-shortened
- **WHEN** outbound text already contains `https://snny.ai/s/Ab3xYz`
- **THEN** that URL is left untouched

#### Scenario: Shortening disabled without config
- **WHEN** `SHORT_LINK_BASE_URL` is unset (e.g. tests, fresh dev checkout)
- **THEN** outbound text is delivered unchanged and no short-link rows are created

#### Scenario: Store failure does not block delivery
- **WHEN** the short-links table is unavailable at send time
- **THEN** the message is still delivered with the original long URL and a warning is logged

### Requirement: Short-link redirect route
The gateway SHALL serve an unauthenticated `GET /s/[hash]` route that responds `302 Found` with `Location` set to the stored long URL. Unknown or malformed hashes SHALL yield `404`. The route SHALL NOT require cookies, sessions, or headers beyond a plain GET, so iMessage link previews and any browser can follow it.

#### Scenario: Valid hash redirects
- **WHEN** a browser requests `GET /s/Ab3xYz` and that hash exists
- **THEN** the response is a 302 redirect to the original URL

#### Scenario: Unknown hash
- **WHEN** a request arrives for a hash with no `short_links` row
- **THEN** the response is 404 with a plain not-found body (no redirect)

### Requirement: Hash minting and permanence
Short-link hashes SHALL be 6 characters drawn from an unambiguous URL-safe alphabet, minted randomly with collision retry against the unique-indexed `short_links` table. Short links SHALL NOT expire: rows persist indefinitely in Postgres and survive process restarts, so links in old iMessage threads keep working for as long as the host serves `snny.ai`.

#### Scenario: Collision on mint
- **WHEN** a freshly minted 6-char hash collides with an existing row
- **THEN** minting retries with a new random hash until the insert succeeds

#### Scenario: Link survives restart
- **WHEN** the Sunny process restarts after a short link was sent
- **THEN** the short link continues to redirect correctly
