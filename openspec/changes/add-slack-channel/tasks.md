# Tasks — add-slack-channel

## 1. Dependency upgrade (isolated for bisect)

- [ ] 1.1 Upgrade `chat` to 4.34.0 and `@chat-adapter/state-memory` to match; add `@chat-adapter/slack@4.34.0`; confirm npm dedupes a single `chat` copy against `chat-adapter-sendblue@^4.23.0`
- [ ] 1.2 Review the Chat SDK 4.30→4.34 changelog for Sendblue-relevant behavior changes; typecheck + full test suite
- [ ] 1.3 Local production build (vite build is NOT in CI) and loopback-channel smoke to confirm the Sendblue driver still constructs and dispatches

## 2. Slack driver

- [ ] 2.1 Create `src/gateway/slack.ts` (`SlackGateway implements Gateway`), modeled on `loopback.ts` structure + `sendblue.ts` Chat-SDK wiring: own `Chat<{ slack }>` instance, memory state, capabilities `{ media: true, typing: best-effort, groups: false, proactiveGroup: false, reactions: false, readReceipts: false }`
- [ ] 2.2 Register `onDirectMessage` / `onNewMention` / `onSubscribedMessage` handlers feeding a shared `dispatch()` that normalizes to `ChannelEvent` (senderId = Slack member id, threadId = Chat SDK native `slack:<channel>:<thread_ts>`)
- [ ] 2.3 Authorization in `dispatch()`: roster-resolve sender; owner DM → dispatch; non-owner DM → drop with log, no reply; mention/channel events → never dispatch in v1
- [ ] 2.4 `send()` with per-thread serialization (`runSerial`), short-link rewrite, discrete post per `OutboundMessage`, API failure surfaced via `SendResult` (no DeliveryTracker)
- [ ] 2.5 Inbound media: map Slack file attachments to normalized `Attachment` with authenticated `fetchData()`; verify prompt persistence through the existing `persistAttachments` path
- [ ] 2.6 Outbound media: native Slack file upload in `send()`; assert the public `/media/[token]` path is never minted for `slack:` threads
- [ ] 2.7 Typing bridge: map `startTyping`/`stopTyping`/`lastSentAt` to whatever the adapter exposes; no-op fallback

## 3. Routing and runtime wiring

- [ ] 3.1 `MultiChannelGateway`: add per-channel driver resolution and route webhooks to the addressed channel (keep threadId-prefix outbound routing); cover with unit tests
- [ ] 3.2 Add `server/routes/webhooks/slack.post.ts` dispatching to the Slack driver (URL-verification challenge and signature checks handled inside `handleWebhook`)
- [ ] 3.3 `runtime.ts`: `slackConfigured` gate (SLACK_BOT_TOKEN + SLACK_SIGNING_SECRET), construct Slack driver into the multi-channel gateway; boot unchanged when unconfigured
- [ ] 3.4 Slack router path uses `CoalescePolicy { quietMs: 0, quietMediaMs: 0 }` for `slack:` threads
- [ ] 3.5 `.env.example`: SLACK_* block with comments; document owner Slack member id in the roster config example

## 4. Tests

- [ ] 4.1 Driver unit tests: normalization, owner/non-owner authorization, retry dedupe (duplicate messageId → single inbound row, single turn), send serialization
- [ ] 4.2 Multi-channel dispatch tests: sendblue webhook → sendblue driver, slack webhook → slack driver, outbound prefix routing
- [ ] 4.3 Guard test: `isGroupThreadId` is false for Slack thread ids; group helpers untouched

## 5. Slack app + deploy (with Devon)

- [ ] 5.1 Author the app manifest (scopes: im:history/read/write, chat:write, users:read, files:read/write, app_mentions:read + channel history for future-proofing; events: message.im, app_mention; events URL https://snny.ai/webhooks/slack); Devon creates the app in the work workspace
- [ ] 5.2 Set SLACK_BOT_TOKEN/SLACK_SIGNING_SECRET on the host, add Devon's Slack member id to `owner.identities`; restart is Devon's call
- [ ] 5.3 Verify the Events API URL-verification handshake succeeds against the live route

## 6. Live smokes

- [ ] 6.1 Sendblue regression: real iMessage round-trip post-upgrade
- [ ] 6.2 Slack owner DM round-trip, including a long turn with an interim update (two discrete posts, in order)
- [ ] 6.3 Slack image inbound (model sees it) and outbound (native upload, no public URL)
- [ ] 6.4 Non-owner DM and a channel @mention: silent, webhook 200, drop visible in logs
- [ ] 6.5 Scheduled/proactive message still lands on iMessage with Slack configured
