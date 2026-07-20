# Add Slack Channel

## Why

Devon wants to reach Sunny from his work Slack, not just iMessage. The gateway was explicitly designed for pluggable channel drivers ("Adding a new channel SHALL NOT require changes to the agent core"), and Sunny already runs on the Vercel Chat SDK — the same SDK whose official `@chat-adapter/slack` adapter provides Slack webhook verification, event normalization, and DM handling. This change cashes in that design: Slack becomes the second live channel with a small driver, not a rearchitecture.

## What Changes

- New `SlackGateway` channel driver (`src/gateway/slack.ts`) wrapping `@chat-adapter/slack`, implementing the existing `Gateway` interface — DM-only reply lane in v1.
- New webhook route `server/routes/webhooks/slack.post.ts` at `https://snny.ai/webhooks/slack` (Events API, not Socket Mode), including Slack's URL-verification challenge.
- `MultiChannelGateway` learns per-channel webhook dispatch (today it forwards all webhooks to the primary driver only).
- Runtime wiring: `slackConfigured` gate in `src/runtime.ts`, `SLACK_*` env vars, roster identities extended with Devon's Slack member ID.
- Dependency upgrade: `chat` 4.30 → 4.34 (required by `@chat-adapter/slack`, which pins the core exactly); `chat-adapter-sendblue` (`^4.23.0` range) is verified against the upgrade with a live iMessage smoke.
- Slack-specific media paths: inbound attachments fetched via authenticated Slack URLs; outbound images sent via Slack file upload — the public `/media/[token]` route is not used for Slack.
- Explicitly out of scope (future-proofed, not built): group/channel participation, @mention responses beyond silence, Block Kit cards, streaming, Slack as a proactive-speech channel. Proactive/person-addressed delivery (schedules, notifications, relays) stays on iMessage.

## Capabilities

### New Capabilities

- `slack-channel`: Slack as a DM-only conversational channel — driver behavior, webhook handling, DM authorization (owner-only in v1, fail-closed for everyone else), Slack thread-id scheme, media in/out over authenticated Slack APIs, event dedupe against Slack retries, and the future-group posture (manifest scopes + silent-unless-rostered).

### Modified Capabilities

- `messaging-gateway`: two requirement-level changes — (1) multi-channel webhook dispatch: when multiple webhook-based drivers are live, each channel's webhook route reaches its own driver; (2) proactive-speech home channel: proactive and person-addressed delivery (schedules, owner notifications, relays) resolves to the iMessage channel even when other channels are configured; other channels carry only conversations they initiated.

## Impact

- **Code**: new `src/gateway/slack.ts`, new `server/routes/webhooks/slack.post.ts`; edits to `src/gateway/multiChannel.ts` (per-channel webhook dispatch), `src/runtime.ts` (wiring + config gate), `.env.example` (SLACK_* block), roster config data (Slack member ID in `owner.identities`). Agent core, router, store, DB schema, and voice layer untouched.
- **Dependencies**: add `@chat-adapter/slack`; upgrade `chat` 4.30 → 4.34 across the existing Sendblue path (regression risk — needs live smoke).
- **External systems**: new Slack app in Devon's work workspace (manifest with bot scopes + event subscriptions pointed at snny.ai); `SLACK_BOT_TOKEN` + `SLACK_SIGNING_SECRET` secrets.
- **Security surface**: one new public webhook endpoint (signature-verified by the adapter); non-owner Slack DMs and all channel/group traffic fail closed. Group participation in the work workspace is deliberately deferred because it needs its own permissioning model.
