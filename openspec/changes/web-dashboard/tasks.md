> Build plan for the web-dashboard change. Read-only observability UI on the
> existing Nitro app. D-WD* decisions are in this change's `design.md`.

## 1. Foundation & layout

- [ ] 1.1 Dashboard route group under `server/routes/dashboard/`; shared server-rendered layout (サニー masthead, Tokyo Night CSS, monospace stack, hyperlink helper) in one template + one CSS file (D-WD1/2).
- [ ] 1.2 Home page: vertical enumerated menu of all pages; child-page chrome: horizontal side-scrolling top menu (D-WD2).
- [ ] 1.3 Small, sanitized server-side markdown→HTML renderer for memory/message content (D-WD5).

## 2. Authentication (iMessage-approval device pairing)

- [ ] 2.1 `dashboard_sessions` + `access_requests` store (Drizzle migration): token (signed, httpOnly cookie), device hint, expiry, revoked flag; pending request id + one-time secret + status (D-WD4).
- [ ] 2.2 Auth middleware: default-deny; valid session → allow; otherwise create a pending request, set a pending cookie, render the "waiting for approval" page (D-WD4).
- [ ] 2.3 Owner approval: Sunny DMs the owner (via the gateway) with device details + a one-time approve link; the approve route validates the secret, marks approved, and issues the session token; default-deny on timeout (D-WD4).
- [ ] 2.4 Session expiry + revocation; localhost-only bind when auth is unconfigured (D-WD4/5).

## 3. Pages

- [ ] 3.1 SUNNY.md and USER.md views (`loadCore`) (D-WD3).
- [ ] 3.2 Memory browser: `INDEX.md` + `topics/` list, each topic openable (`readTopic`) (D-WD3).
- [ ] 3.3 Conversation view: recent messages per thread (role/time/delivered text + retained scratch from the `UIMessage` payload) + keyword search (`recall`) (D-WD3).
- [ ] 3.4 Schedules & runs view: `schedules` + `schedule_runs` (next run, active, status, output/error) (D-WD3).
- [ ] 3.5 Activity & health view: per-turn metrics from message-payload metadata (tokens/cache/delivered/steps) + a service/Postgres/scheduler/gateway health panel incl. unprocessed-inbound count; non-secret config only (D-WD3/5).

## 4. Verify

- [ ] 4.1 Confirm no route mutates Sunny state except auth; no secret is rendered anywhere (D-WD5/6).
- [ ] 4.2 End-to-end: unknown device → owner approval DM → token → pages render; revocation forces re-pairing; unconfigured-auth binds localhost.
