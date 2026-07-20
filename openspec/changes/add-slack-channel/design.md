# Design — add-slack-channel

## Context

Sunny's agent core speaks only the `Gateway` interface (`src/gateway/types.ts`); transports are pluggable drivers behind that seam. Today three implementations exist: `SendblueGateway` (iMessage/SMS via Chat SDK + `chat-adapter-sendblue`), `LoopbackGateway` (test channel), and `MultiChannelGateway` (prefix-routed fan-out). Conversations are keyed by opaque `threadId` strings; the store, router, and DB schema are channel-agnostic. The unified voice layer routes all speech through `deliver()`, whose `chat` audience is the sole caller of `gateway.send()`.

Slack joins as the second live channel: a DM assistant to Devon in his work workspace. Group participation is deferred (it needs its own permissioning model) but must not be architecturally foreclosed.

## Goals / Non-Goals

**Goals:**
- Slack DMs with the owner drive full conversational turns — same personality, same reply lane, including multiple sends per turn (interim updates, backstop, images).
- No agent-core changes; Slack is a driver + route + wiring.
- Future-proof for @mention group participation: manifest scopes, mention handlers, and thread-id scheme all accommodate groups later; the existing fail-closed authorizer keeps everything but the owner DM silent until then.
- Sendblue behavior is preserved through the required `chat` upgrade.

**Non-Goals:**
- Group/channel participation, mention replies, or a Slack trust policy beyond fail-closed.
- Block Kit cards, modals, slash commands, native streaming.
- Slack as a proactive-speech channel — schedules, notifications, and relays stay on iMessage.
- A persistent Chat SDK state adapter (memory state is acceptable for DM-only; revisit with groups).

## Decisions

### D1. Official `@chat-adapter/slack` on the existing Chat SDK foundation
Sunny already wraps Chat SDK adapters (`SendblueGateway` holds a `Chat<{ sendblue }>` instance). `SlackGateway` mirrors that: its own `Chat<{ slack: createSlackAdapter() }>` instance with `@chat-adapter/state-memory`, `chat.onDirectMessage` / `chat.onNewMention` / `chat.onSubscribedMessage` handlers feeding a shared `dispatch()` that normalizes to `ChannelEvent`. Alternative — hand-rolling against `@slack/web-api` — rejected: the adapter provides signature verification, URL-challenge handling, event parsing, markdown→mrkdwn conversion, and file handling we'd otherwise reimplement.

Each driver keeps its **own** `Chat` instance (as Sendblue does today) rather than one shared multi-adapter instance. This preserves driver independence at the Gateway seam, keeps the Sendblue path untouched, and sidesteps cross-adapter state coupling. The Chat SDK's own multi-adapter mode is unnecessary because sunny's `MultiChannelGateway` already plays that role.

### D2. Version strategy: upgrade `chat` to 4.34
`@chat-adapter/slack@4.34.0` pins `chat@4.34.0` exactly, so the core upgrades 4.30 → 4.34. `chat-adapter-sendblue@0.2.0` declares `chat@^4.23.0`, so npm dedupes to one copy. Risk is behavioral drift in the Sendblue path; mitigation is a live iMessage smoke as an explicit task before merge. Alternative — pinning an older `@chat-adapter/slack` matching 4.30 — rejected: stale adapter, and the upgrade is owed anyway.

### D3. Events API webhook, not Socket Mode
`server/routes/webhooks/slack.post.ts` mirrors the Sendblue route: resolve the Slack driver, `return driver.handleWebhook(event.req)`. The adapter verifies `SLACK_SIGNING_SECRET` signatures and answers the URL-verification challenge. snny.ai ingress already exists, and a webhook drops straight into the `handleWebhook(Request)` seam. Socket Mode (also shipped with the adapter) rejected: a long-lived socket outside the gateway seam, another connection to supervise, no benefit given existing ingress.

### D4. `MultiChannelGateway` webhook dispatch by channel
Today `handleWebhook` forwards only to the primary driver. Change: the multi-channel gateway exposes per-channel access (e.g. `driverFor(channel)`), and each webhook route addresses its own channel explicitly. Outbound routing already works by threadId prefix (`slack:` → Slack driver, `sendblue:` → Sendblue). Alternative — sniffing the payload inside one shared `handleWebhook` — rejected: the route already knows the channel; sniffing adds fragile parsing for nothing.

### D5. Thread-id scheme: Chat SDK native, no convention changes
Chat SDK Slack thread ids are `slack:<channelId>:<thread_ts>` (e.g. `slack:D0ABC:1721234.5678`). Position 2 is a timestamp and can never equal `'g'`, so `isGroupThreadId` correctly reads every Slack thread as non-group in v1 — no changes to `threadId.ts` or its call sites. When groups land, group-ness is derivable from the Slack channel-id prefix (`C…` channel vs `D…` DM) and `isGroupThreadId` becomes channel-aware then, not now. Per Chat SDK norms, each Slack thread is its own sunny conversation; top-level DM messages start conversations, thread replies continue them.

### D6. Authorization: owner-only DMs, fail-closed everywhere else
The existing `Authorizer` resolves `senderId` against roster identities; Slack member IDs (e.g. `U0123ABC`) pass through `normalize()` unchanged and are added to `config.owner.identities` as data — no schema change (identities were spec'd as channel-stable addresses). v1 posture: DMs from the owner's Slack ID dispatch; DMs from anyone else are dropped (fail-closed, logged); mention/channel events are received (handlers registered, manifest scopes granted) but never dispatched because participants aren't rostered. Future group support becomes roster data + a trust-policy decision, not rearchitecture.

### D7. Reply lane: post-per-message, no streaming
`deliver()` emits complete messages, and Sunny's within-turn cadence (interim updates, final reply, backstop) maps 1:1 onto discrete Slack posts. `SlackGateway.send()` posts each `OutboundMessage` to the thread, serialized per-thread via the existing `runSerial` pattern. Chat SDK's native streaming rejected for v1: it would open a token-level speech path around the `deliver()` seam for cosmetic benefit; revisit if Slack-native streaming UX is ever wanted. Typing: the router's existing typing bridge calls `startTyping`/`stopTyping`; the driver maps these to the adapter's typing support (best-effort no-op where unsupported).

### D8. Media over authenticated Slack APIs
Inbound: Slack file attachments require a bearer token to download; the driver's attachment mapping wraps the adapter's authenticated fetch in `fetchData()`, then the existing prompt-persistence path (`persistAttachments`) stores bytes as usual. Outbound: `capabilities.media = true` for DMs; `send()` uploads the attachment bytes via the adapter/Web API file upload instead of the Sendblue-style public `media_url`. The public `/media/[token]` route and `hostLocalFile()` are not used for Slack. The short-link rewrite still applies to outbound text (spec `short-links` mandates it at every transport chokepoint).

### D9. Sendblue-only subsystems explicitly omitted
- **DeliveryTracker**: Slack `chat.postMessage` is synchronous-success; no async status callbacks exist. The API result is terminal; failures surface as `SendResult` errors through the existing send-failure path.
- **Coalescing**: Slack delivers one event per message. The Slack router path uses `quietMs: 0` (the `CoalescePolicy` is already injectable); no multipart heuristics.
- **Public media hosting**: see D8.

### D10. Dedupe and restarts with memory state
Slack retries undelivered events (~3× with backoff). First line: Chat SDK's dedupe cache (in-memory, `dedupeTtlMs`). Second line: `store.appendInbound`'s `(channel, messageId)` unique index makes redelivery idempotent at the store layer. A restart inside the retry window can at worst re-trigger a turn for an already-answered message; `hasUnansweredInbound` gating bounds the damage. Accepted for DM-only v1; a drizzle-backed state adapter is the follow-up when groups need durable thread subscriptions.

### D11. Proactive speech stays on iMessage
`resolveMemberThread`, `resolvePersonThread`, scheduler owner-DM resolution, and owner notifications keep constructing Sendblue DM ids from `SENDBLUE_FROM_NUMBER` — untouched. Slack carries only conversations it initiated (inbound → reply lane). This is now a spec-level requirement (messaging-gateway delta) so a future "home channel per person" change has to consciously supersede it.

### D12. Config and boot
`slackConfigured` gate in `runtime.ts` mirrors the Sendblue gate: when `SLACK_BOT_TOKEN`/`SLACK_SIGNING_SECRET` are absent, boot proceeds without the Slack driver (first-run-setup's transport-optional invariant). When configured, the Slack driver joins `MultiChannelGateway` alongside Sendblue (and loopback where enabled). Secrets follow the existing pattern for transport credentials (`.env` on the host; values never enter LLM context).

## Risks / Trade-offs

- [`chat` 4.30→4.34 breaks the Sendblue path] → community adapter's `^4.23.0` range claims compatibility; explicit live iMessage smoke task before merge; upgrade isolated in its own task/commit for easy bisect.
- [Slack 3-second webhook ack deadline] → the adapter acks before processing (events are handled async); verify under real turns during smoke — a slow ack causes Slack retries, which dedupe must absorb (D10).
- [Restart inside Slack's retry window double-processes a message] → store-level `(channel, messageId)` dedupe + answered-inbound gating; accepted residual risk for v1 (D10).
- [Owner's Slack ID misconfigured → Sunny silent in Slack] → fail-closed is the designed behavior; setup task includes a checklist step to capture the member ID from the workspace profile and a smoke that proves an owner DM round-trip.
- [Work-workspace exposure: anyone can DM the bot] → non-roster DMs drop with a log line, no reply (no information leak); channel/group events never dispatch. Slack app is installed only to Devon's workspace with least-privilege scopes.
- [Typing/read-receipt semantics differ from iMessage] → capabilities flags advertise honestly; graceful-degradation requirement already covers absent capabilities.

## Migration Plan

1. Land the `chat` upgrade + adapter dependency first; run the Sendblue live smoke.
2. Add driver, route, multi-channel dispatch, and wiring behind the `slackConfigured` gate (deploy-inert until env vars exist).
3. Create the Slack app from a manifest (scopes: `im:history`, `im:read`, `im:write`, `chat:write`, `users:read`, `files:read`, `files:write`, plus `app_mentions:read` + channel history scopes for future-proofing; events: `message.im`, `app_mention`), point events at `https://snny.ai/webhooks/slack`, install to workspace.
4. Set `SLACK_BOT_TOKEN`/`SLACK_SIGNING_SECRET`, add Devon's member ID to `owner.identities`, restart (Devon's call, per deploy policy).
5. Smoke: URL-verification handshake; owner DM round-trip; image in both directions; non-owner DM stays silent; Sendblue regression check.
6. Rollback: unset `SLACK_*` env vars (driver gate turns Slack off); dependency rollback = revert the upgrade commit.

## Open Questions

- Exact `@chat-adapter/slack` typing-indicator surface (assistant-thread status vs classic typing) — resolve during implementation; degrade to no-op if absent.
- Whether Chat SDK 4.34 changed `chat-adapter-sendblue`-relevant behavior (changelog review during the upgrade task).
