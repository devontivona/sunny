## ADDED Requirements

### Requirement: Read-only observability dashboard
Sunny SHALL serve a web dashboard, from the existing application server, that displays its internal state for observation only. The dashboard SHALL NOT provide a chat interface or any control over Sunny (no sending messages, editing memory, or triggering schedules/jobs), and no dashboard route SHALL mutate Sunny's state except authentication session management.

#### Scenario: Dashboard is observe-only
- **WHEN** a user views any dashboard page
- **THEN** it displays Sunny's state read-only
- **AND** there is no control to send a message, edit memory, or trigger a schedule or job

### Requirement: Terminal-UI visual language
The dashboard SHALL present a terminal-inspired interface: a dark background, a monospace/coder font, and the Katakana name for Sunny (サニー) as the masthead at the top of every page. Links SHALL be rendered as human-readable hyperlinks rather than raw URLs. The color scheme SHALL follow a popular VS Code dark theme (Tokyo Night). The home page SHALL present its menu as a vertical list; child pages SHALL present the menu as a horizontal, side-scrolling bar at the top.

#### Scenario: Masthead and theme
- **WHEN** any dashboard page loads
- **THEN** it shows the サニー masthead, a dark Tokyo-Night palette, and a monospace font

#### Scenario: Hyperlinks, not raw URLs
- **WHEN** the dashboard links to another page or resource
- **THEN** it renders a human-readable hyperlink, not a bare URL string

#### Scenario: Menu placement differs by page type
- **WHEN** the home page is shown
- **THEN** the menu is a vertical enumerated list
- **WHEN** a child page is shown
- **THEN** the menu is a horizontal, side-scrolling bar at the top

### Requirement: Memory views
The dashboard SHALL render the memory soul: the always-on core (`SUNNY.md` and `USER.md`) and a browser over `INDEX.md` and the topic documents. Memory content SHALL be rendered (markdown) and sanitized.

#### Scenario: View core memory
- **WHEN** the owner opens the SUNNY.md or USER.md page
- **THEN** the current file contents are rendered

#### Scenario: Browse topic docs
- **WHEN** the owner opens the memory browser
- **THEN** `INDEX.md` and the list of topic documents are shown, each openable to view its contents

### Requirement: Conversation view
The dashboard SHALL show recent conversation from the message store, grouped by thread, including each turn's role, timestamp, delivered text, and — for Sunny's turns — the retained private scratch from the stored `UIMessage` payload. It SHALL support keyword search over message history.

#### Scenario: View recent conversation
- **WHEN** the owner opens the conversation page for a thread
- **THEN** recent messages are shown with role and timestamp
- **AND** Sunny's retained scratch (working context not delivered to the user) is viewable alongside its delivered messages

#### Scenario: Search history
- **WHEN** the owner enters a keyword search
- **THEN** matching past messages are returned

### Requirement: Schedules and run history view
The dashboard SHALL list Sunny's schedules (kind, spec, label, next run, active state) and the recent run history for each (fired time, status, output or error).

#### Scenario: View schedules and outcomes
- **WHEN** the owner opens the schedules page
- **THEN** active and inactive schedules are listed with their next run times
- **AND** recent runs are shown with status and output/error

### Requirement: Activity and health view
The dashboard SHALL present per-turn activity metrics derived from stored turn metadata (token usage including cached/written, delivery path, step count) and a service health panel (application, database, scheduler, gateway status, and the count of unprocessed inbound messages).

#### Scenario: View activity and health
- **WHEN** the owner opens the activity/health page
- **THEN** recent turns are shown with token usage, cache read/write, delivery path, and step count
- **AND** a health panel shows whether the service, database, scheduler, and gateway are healthy

### Requirement: iMessage-approval device authentication
Access to the dashboard SHALL be default-deny. A request from a device without a valid session SHALL create a pending access request and cause Sunny to send the **owner** an approval prompt over the messaging gateway containing a one-time approval secret. Only the owner SHALL be able to approve. On approval, the requesting device SHALL receive a signed, httpOnly session token; sessions SHALL be expirable and revocable. Pending requests SHALL default-deny on timeout. The dashboard SHALL NOT serve private data to an unapproved device.

#### Scenario: Unknown device requests access
- **WHEN** a device without a valid session opens the dashboard
- **THEN** a pending access request is created and the owner is messaged with an approval prompt
- **AND** the device sees a "waiting for approval" state, not the dashboard contents

#### Scenario: Owner approves a device
- **WHEN** the owner approves the request (via the one-time secret delivered to their DM)
- **THEN** the requesting device receives a session token and can view the dashboard

#### Scenario: Unapproved or timed-out access is denied
- **WHEN** a device is not approved (denied, or the request times out)
- **THEN** it is not granted a session and cannot view dashboard contents

#### Scenario: Session revocation
- **WHEN** a session is revoked or expires
- **THEN** that device must request access again before viewing the dashboard

### Requirement: No secret exposure
The dashboard SHALL NOT render secret values. Any configuration shown SHALL be limited to non-secret settings.

#### Scenario: Config view excludes secrets
- **WHEN** the dashboard displays configuration or health
- **THEN** no secret (e.g. API keys, tokens) appears in the output
