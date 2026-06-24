## Why

iMessage is a photo-heavy medium, but Sunny is deaf and mute to images: an inbound photo
arrives as an empty/text-only message (the gateway normalizes attachment metadata, then drops
it before the model), and Sunny can only ever reply with text. The owner naturally sends
screenshots and photos and expects images back — a chart, a website-builder preview, a diagram.
This closes that gap in both directions over Sendblue.

## What Changes

- **Inbound (receive):** Consume the attachments the gateway already normalizes. Fetch bytes
  promptly (Sendblue media URLs expire), persist them to disk under `~/.sunny`, and feed the
  model proper content parts — **best-effort across all types**: `image/*` → vision, `application/pdf`
  → document, and any type the model API can't ingest → the saved file's **local path + MIME
  surfaced to the model** so Sunny can act on it via the bash/file tools. Nothing is silently
  dropped. All inbound media content is treated as **untrusted data**.
- **Outbound (send):** `send_message` gains an optional image (a local file path Sunny produced,
  or a URL). The gateway sends it via the adapter's `sendMediaMessage` (Sendblue fetches a public
  `media_url` server-side). A new **tokenized public media route**, served from the same public
  server Sendblue already webhooks to, hosts local files for Sendblue to fetch — unguessable
  token, short TTL, serves only files Sunny explicitly published.
- **Groups:** Media *send* is DM-only (the Sendblue adapter returns early for group threads). In a
  group, Sunny posts the **public media URL as a text link** instead. Inbound images from groups
  are still ingested for vision.
- **Gateway seam:** `OutboundMessage` and `Attachment` are extended (additive) to carry media; a
  per-channel `media` capability flag is added for feature-detection.
- **Dashboard:** the conversation view renders inbound/outbound images (observe-only), per the
  data-driven dashboard pattern.

No breaking changes — the seam additions are optional fields; the agent core compiles unchanged.

## Capabilities

### New Capabilities
- `message-media`: receiving and sending images/attachments over the messaging gateway —
  inbound fetch + disk persistence + conversion to model content parts (vision/document/file),
  outbound image send with public-URL hosting, the group public-link fallback, and the
  untrusted-content posture for inbound media.

### Modified Capabilities
- `messaging-gateway`: the normalized seam gains media — `Attachment` carries retrievable
  content, `OutboundMessage` carries an attachment, inbound attachments are no longer dropped,
  and the capability flags advertise media support.
- `web-dashboard`: the conversation view renders message images (inbound and outbound).

## Impact

- **Code:** `src/gateway/types.ts` (Attachment / OutboundMessage / capabilities), `src/gateway/
  sendblue.ts` (inbound fetch+persist, outbound `sendMediaMessage`, group link), `src/gateway/
  store.ts` (`userPayload` carries media parts; persistence + recovery), `src/agent/loop.ts` +
  the `toModelMessages` converter (media parts → model content), `src/agent/tools/sendMessage.ts`
  (+specs: image param), a new media-storage module (`~/.sunny/media`), a new public route
  `server/routes/media/[token].get.ts`, and `src/dashboard/data.ts` + the conversation UI.
- **Dependencies:** none new — `chat-adapter-sendblue` already supports media both ways
  (`buildAttachment` / `fetchData` inbound, `sendMediaMessage` outbound); the model API already
  accepts image + document parts.
- **Config / ops:** a public base URL for building media links (reuse `DASHBOARD_PUBLIC_URL` or a
  dedicated var); the host must be publicly reachable (already true for the webhook). Verify early
  whether Sendblue accepts `data:` URIs (could skip hosting for tiny images).
- **Security:** inbound content is untrusted; the outbound media route is unauthenticated (Sendblue
  can't present a session) and so relies on unguessable tokens + short TTL + serving only
  explicitly-published files; image bytes are private (kept off logs).
