# Design — Messaging Media (images in + out over Sendblue)

> Receiving and sending images/attachments over the messaging gateway. The capability composes
> over the existing seam (`messaging-gateway`) and the Sendblue adapter, which already supports
> media both ways; the work is wiring it through to the model and out to the carrier.

## Context

Today the gateway normalizes inbound attachment **metadata** into `ChannelEvent.attachments`
(`sendblue.ts:200`) but nothing consumes it: `appendInbound` persists only a text part
(`userPayload`), the recovery path hardcodes `attachments: []`, and the model-input builder
(`store.recentWindow` → `toModelMessages`) sees text only. Outbound is `{ text }`-only.

Verified facts that shape the design (`chat-adapter-sendblue` 0.x, installed):
- **Inbound:** the raw Sendblue payload carries `media_url`; the adapter's `buildAttachment`
  yields `{ type: 'image'|'file', name, mimeType, url, fetchData() }` (or `{ data }` for `data:`
  URIs). `fetchData()` is a plain unauthenticated `fetch(media_url)`. Sendblue media URLs are
  short-lived, so bytes must be pulled **promptly**.
- **Outbound:** `adapter.sendMediaMessage(threadId, mediaUrl, content?)` → Sendblue
  `messages.send({ media_url })`. Sendblue fetches the URL **server-side**, so it must be a
  publicly reachable URL. The method **returns early for group threads** (`if (decoded.groupId)
  return`) — media send is DM-only.
- The model API (Opus 4.8) accepts `image` and `document` (PDF) content parts; it cannot ingest
  audio/video.
- Messages are stored as a `UIMessage` `payload` (jsonb) that is replayed verbatim via
  `toModelMessages` (D-MG9). The current inbound message is persisted *before* the turn runs, so
  it is already in `recentWindow` — i.e. **the payload is the single seam** through which media
  reaches the model, history, and crash recovery.

## Goals / Non-Goals

**Goals:**
- Inbound images reach the model as vision; PDFs as documents; every other type is saved and its
  path surfaced so Sunny can act on it (best-effort, nothing dropped).
- Sunny can attach an image to a reply (a file it produced or a URL), delivered as a real MMS
  attachment in DMs and as a public link in groups.
- Media survives history replay and crash-before-processing (durable, not dependent on the
  expiring Sendblue URL).
- No new runtime dependency; no DB migration (media refs ride in the existing jsonb payload).

**Non-Goals:**
- **Image generation** — this is transport, not creation. Sunny producing an image (charts,
  renders) is done by existing tools/skills; this change only sends what already exists on disk.
- Reactions, voice notes as audio understanding, video understanding (model can't ingest them —
  they become saved-file notes).
- A general file-manager UI. The dashboard only *renders* message media.
- Per-image approval gating (that posture belongs to `security-permissions`; sends here are
  owner-attended).

## Decisions

- **D-MM1 — Media rides the persisted `UIMessage` payload; no side channel, no DB migration.**
  Inbound attachments become content parts in the stored `payload` (jsonb), exactly like text
  (D-MG9). This single seam gives us model input (replayed via `toModelMessages`), history, and
  crash recovery for free. `findUnprocessedInbound` must reconstruct `event.attachments` from the
  payload instead of `[]`. *(Alternative: a new `attachments` table/column — rejected; it
  duplicates the payload-as-record model and forces a migration for no gain.)*
- **D-MM2 — Inbound: fetch promptly, persist bytes to disk, reference by path.** On webhook
  receipt (before the turn), `fetchData()` each attachment and write it under
  `~/.sunny/media/inbound/<message-id>/<n>.<ext>` (Sendblue URLs expire — lazy fetch would lose
  them). The payload stores a **reference** (local path, mime, type, size), not the bytes; the
  model-input builder reads the file at turn time and inlines it. *(Alternative: base64 the bytes
  into the jsonb payload — rejected: bloats the DB and re-bills the bytes as tokens on every
  history replay.)* Media bytes live outside the `~/.sunny` git repo (gitignored) — they're data,
  not reviewable config.
- **D-MM3 — Best-effort type mapping at model-input conversion.** In `toModelMessages`, map each
  stored attachment by MIME:
  - `image/*` → an `image` content part (vision). HEIC/HEIF and other non-model formats are
    **transcoded to JPEG** first if a cheap path exists, else fall through to the file-note.
  - `application/pdf` → a `document`/`file` content part (Claude reads PDFs).
  - anything else → a **text note** (`[attachment: <name> (<mime>), saved at <path>]`) so Sunny
    can open it with `bash`/`file_read`. Nothing is silently dropped.
  Caps: at most N attachments/message and ~5 MB each fed inline; oversized/over-count items
  degrade to the file-note (still saved, just not inlined).
- **D-MM4 — Outbound hosting: a tokenized public route on the existing public server.** Files
  Sunny sends are published to `~/.sunny/media/outbox/<token>.<ext>` (`<token>` = crypto-random,
  URL-safe); a new public route `GET /media/<token>` streams the file. The public link is built
  from a configured base URL (reuse `DASHBOARD_PUBLIC_URL`, or a dedicated `PUBLIC_BASE_URL`).
  The route is **unauthenticated** (Sendblue can't present a session) — safety comes from: an
  unguessable token (≥128 bits), serving **only** files in the outbox (token → fixed dir, never a
  caller-supplied path, no traversal), a content-type from the stored mapping, and a **short TTL**
  with cleanup (Sendblue fetches within seconds + a few retries; e.g. 24 h then delete). If the
  send tool is handed an existing URL, it's passed straight through as `media_url` (no hosting).
  *(Alternatives: devbox public hosting — ties every send to the daemon lifecycle; object storage
  — adds a cloud dep + credentials. Both rejected for the MVP; the in-process route is
  self-contained and reuses the ingress we already operate for the webhook.)*
- **D-MM5 — Outbound send: extend the seam + the `send_message` tool, one image per send.**
  `OutboundMessage` gains an optional `attachment` (`{ pathOrUrl, mimeType? }`); `Gateway.send`
  routes to `sendMediaMessage` when present (text becomes the MMS `content`/caption), else
  `postMessage` as today. `send_message` gains an optional `image` arg (a local path Sunny
  produced or a URL). Sendblue's `media_url` is singular, so one image per send; multiple images =
  multiple sends. The model handles names/paths, never the bytes.
- **D-MM6 — Groups get a public link, not an attachment.** `sendMediaMessage` is DM-only. For a
  group thread, the gateway hosts the file (D-MM4) and appends/sends the **public URL as text**.
  Inbound group images are ingested normally (D-MM2). Feature-detected via the thread's group-ness
  (already derived from the threadId).
- **D-MM7 — A `media` capability flag.** `ChannelCapabilities` gains `media: boolean` (Sendblue =
  true). The send path feature-detects it and degrades gracefully (drop the image with a note) on
  a channel that lacks media, keeping the seam channel-agnostic (D-MG3).
- **D-MM8 — Inbound media is untrusted data.** Image/file content (incl. text rendered inside an
  image) is never treated as instructions; the system prompt says so, mirroring the email/browse
  posture. Bytes never hit logs — only metadata (name/mime/size), and content logging stays behind
  `SUNNY_LOG_CONTENT`.
- **D-MM9 — Dashboard renders media via a session-gated route.** The conversation view shows
  inbound/outbound images. The dashboard serves bytes through its **own authenticated** media
  route (distinct from the public Sendblue route in D-MM4 — that one is unauthenticated by
  necessity and must not become a general file server). Data-driven from the stored payload.

## Risks / Trade-offs

- **Sendblue inbound URLs expire** → fetch synchronously on webhook receipt, before the turn, and
  persist; never rely on the URL later. If a fetch fails, persist a note and continue (don't drop
  the whole message).
- **HEIC from iPhones** → the model API rejects HEIC. Verify the MIME Sendblue actually delivers
  (carriers often transcode to JPEG); if HEIC arrives, transcode to JPEG, and if no cheap decoder
  is available, fall back to the saved-file note rather than failing. *(Open question below.)*
- **Unauthenticated public media route** → unguessable token + serve-only-outbox + no
  caller-supplied paths + short TTL. It serves only files Sunny explicitly published; it is never
  a path-addressable file server. Document that the host being publicly reachable (already true for
  the webhook) is what makes this work.
- **Egress / privacy** → an outbound image leaves the host to Sendblue and the carrier (inherent
  to MMS); sends are owner-initiated/attended. Inbound bytes are the owner's data stored on the
  host — retained durably for history; a retention/cleanup policy is noted as future.
- **Disk growth** → outbox is short-TTL-cleaned; inbound is retained (modest volume for one user)
  with cleanup deferred.

## Migration Plan

Additive and restart-only. New storage dirs (`~/.sunny/media/{inbound,outbox}`) and the public
route are created on boot; `media/` is gitignored. **No DB migration** — media refs live in the
existing jsonb payload (D-MM1); legacy text-only rows replay exactly as before. Rollback = revert
the code; stored payloads with media parts simply degrade to their text on an older build (the
`text` projection is unchanged). Config: set the public base URL once.

## Open Questions

- **Does Sendblue accept `data:` URIs as `media_url`?** If yes, tiny outbound images could skip
  hosting entirely. Verify early; the design assumes a fetchable URL either way (hosting is needed
  for anything but the smallest images, so it's not blocking).
- **HEIC decode path.** Confirm the delivered MIME for iPhone photos; decide transcode-lib vs
  file-note fallback based on what arrives and whether a dependency-free decode is feasible.
- **Inbound retention.** Durable-forever vs windowed cleanup — defaulting to durable; revisit if
  volume warrants.
