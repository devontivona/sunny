## ADDED Requirements

### Requirement: Agent-mintable public callback endpoints
Sunny SHALL have an `oauth_callback` tool (trusted-DM-only) that mints a public callback URL on demand for OAuth-style redirect flows (CLI logins, device registrations). Each `create` call SHALL return a URL of the form `<SHORT_LINK_BASE_URL>/cb/<token>` where `<token>` is a cryptographically random, unguessable identifier (≥ 128 bits, URL-safe). The tool call SHALL accept an optional human-readable `label` (what flow this is for) and an optional `ttl` (default 30 minutes, bounded) after which the endpoint expires. The tool SHALL also support `check` (return the status and any captured parameters of a callback by id) and `cancel` (deactivate a pending callback).

#### Scenario: Minting a callback for a CLI login
- **WHEN** Sunny runs a CLI whose OAuth flow accepts a custom redirect URI and calls `oauth_callback` with action `create` and label "gcloud login"
- **THEN** the tool returns a live public URL like `https://snny.ai/cb/9f3k...` that Sunny can pass to the CLI as its redirect URI

#### Scenario: Checking a pending callback
- **WHEN** Sunny calls `oauth_callback` with action `check` for a callback that has not been hit
- **THEN** the tool reports status `pending` with the remaining TTL

#### Scenario: Cancel deactivates the endpoint
- **WHEN** Sunny cancels a pending callback and someone later hits its URL
- **THEN** the request receives the expired/unknown page and no wake occurs

### Requirement: Callback hit captures the request and wakes Sunny
When a pending callback URL receives a GET request, the gateway SHALL (1) record the full query string and parsed parameters plus minimal metadata (timestamp, CF-Connecting-IP) on the callback row, (2) respond with a friendly branded HTML page telling the human the step is complete and the tab can be closed — never echoing captured parameter values into the page — and (3) wake the originating thread with a new turn whose triggering event carries the callback id, label, and captured parameters, using the same inbox-append + `wakeThread` mechanism as inbound webhooks. Sunny can then complete the flow itself (e.g. forward `code`/`state` to the CLI's waiting localhost listener) instead of asking the user to copy the redirect URL back.

#### Scenario: OAuth redirect completes hands-free
- **WHEN** Devon taps the auth link on his phone and the provider redirects his browser to `https://snny.ai/cb/<token>?code=4/0Adk...&state=xyz`
- **THEN** Devon's browser shows a "done — you can close this tab" page
- **AND** a new turn wakes in the originating thread carrying `code` and `state`, and Sunny forwards them to the waiting CLI listener to finish the token exchange

#### Scenario: Captured secrets stay off the response page
- **WHEN** a callback is hit with `?code=...` in the query
- **THEN** the rendered HTML contains no query-parameter values

### Requirement: Callback lifecycle is single-capture and expiring
A callback endpoint SHALL be single-capture: the first hit transitions it `pending → captured` and triggers exactly one wake; subsequent hits SHALL receive an "already completed" page and SHALL NOT re-wake Sunny or overwrite the captured parameters. An endpoint past its TTL SHALL behave like an unknown token (no capture, no wake). Unknown, expired, and cancelled tokens SHALL all render the same non-committal page, so the public route leaks nothing about which tokens exist. Callback rows (including captured parameters) MAY be pruned after capture is consumed; OAuth authorization codes are short-lived single-use values, so retained rows are not treated as live secrets, but captured parameters SHALL never be logged at info level or included in error reports.

#### Scenario: Second hit does not re-wake
- **WHEN** a captured callback URL is hit a second time (e.g. the user refreshes the tab)
- **THEN** the page says the step was already completed and no new turn is triggered

#### Scenario: Expired callback leaks nothing
- **WHEN** a request arrives for a token that is expired, cancelled, or never existed
- **THEN** all three cases render the same page with no indication of which case applied
