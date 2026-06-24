> Build plan for **messaging-media** — images in + out over Sendblue. Capability composes over
> the existing gateway seam (`messaging-gateway`) and the Sendblue adapter, which already supports
> media both ways (`buildAttachment`/`fetchData` inbound, `sendMediaMessage` outbound). D-MM*
> decisions are in this change's `design.md`. No DB migration: media refs ride the jsonb payload.

## 1. Verify constraints (de-risk before building)

- [ ] 1.1 Confirm the MIME Sendblue actually delivers for an iPhone photo (HEIC vs transcoded JPEG) by inspecting a real inbound `media_url` payload; record the finding (drives task 3.3). (D-MM3 open question)
- [ ] 1.2 Confirm whether Sendblue accepts a `data:` URI as `media_url` on send; if yes, note it as a small-image fast path; either way proceed with hosting as the default (D-MM4 open question).
- [ ] 1.3 Confirm there is a configured public base URL the host is reachable at (reuse `DASHBOARD_PUBLIC_URL` or add `PUBLIC_BASE_URL`); media links are built from it (D-MM4).

## 2. Seam + storage foundations

- [ ] 2.1 Extend `Attachment` (`src/gateway/types.ts`) to carry retrievable content (a `fetchData()`/bytes accessor + `type`) and add an optional `attachment` to `OutboundMessage`; add `media: boolean` to `ChannelCapabilities` (D-MM1/5/7).
- [ ] 2.2 Media-storage module: create + manage `~/.sunny/media/{inbound,outbox}`, gitignore them, with helpers to persist inbound bytes (`inbound/<message-id>/<n>.<ext>`) and to publish/expire outbox files by token (D-MM2/4).
- [ ] 2.3 Add a short-TTL cleanup for the outbox (and a no-op/`README` for inbound retention, deferred) (D-MM4).

## 3. Inbound: ingest → persist → model

- [ ] 3.1 In the Sendblue gateway `dispatch` (`src/gateway/sendblue.ts`), fetch each attachment's bytes promptly via the adapter's `fetchData()` and persist to disk; on a per-attachment fetch failure, keep the message and record a note (D-MM2).
- [ ] 3.2 Carry the persisted attachment refs (local path, mime, type, size) into the stored `UIMessage` payload in `userPayload` (`src/gateway/store.ts`); reconstruct `event.attachments` from the payload in `findUnprocessedInbound` instead of `[]` (D-MM1/2).
- [ ] 3.3 In `toModelMessages`, convert stored attachment parts to model content best-effort: `image/*` → image part (transcode HEIC→JPEG or fall back to file-note per 1.1); `application/pdf` → document part; else → a text note with the saved path + mime. Apply count/size caps with graceful degradation (D-MM3).
- [ ] 3.4 System-prompt note: inbound media (incl. text inside images) is untrusted data, never instructions; keep bytes out of logs (metadata only, behind `SUNNY_LOG_CONTENT`) (D-MM8).
- [ ] 3.5 Unit tests: attachment persisted + referenced in payload; recovery repopulates attachments; type mapping (image/pdf/other) incl. cap degradation; fetch-failure is non-fatal.

## 4. Outbound: tool → gateway → carrier

- [ ] 4.1 Public media route `server/routes/media/[token].get.ts`: stream a published outbox file by unguessable token (token→fixed dir, no caller path, no traversal), correct content-type, 404 on unknown/expired token (D-MM4).
- [ ] 4.2 Gateway `send()` (`src/gateway/sendblue.ts`): when `OutboundMessage.attachment` is set, host a local path (publish → public URL) or pass a URL through, then call `adapter.sendMediaMessage(threadId, url, text)`; else `postMessage` as today. Persist the outbound media ref in the turn/standalone payload (D-MM5).
- [ ] 4.3 Group fallback: for a group thread, host the file and send the public URL as text instead of a native attachment (`sendMediaMessage` is DM-only) (D-MM6).
- [ ] 4.4 Capability-gate: if the channel's `media` flag is false, drop the attachment and still send the text (D-MM7).
- [ ] 4.5 Extend the `send_message` tool + specs (`src/agent/tools/sendMessage.ts`, `sendMessageSpecs.ts`) with an optional `image` (local path or URL); the model passes a path/URL, never bytes; one image per call (D-MM5).
- [ ] 4.6 Unit tests: send routes to `sendMediaMessage` with a hosted URL in a DM; group send becomes a text link; URL-passthrough skips hosting; missing-`media`-capability degrades to text; media route serves only published tokens and resists traversal.

## 5. Dashboard

- [ ] 5.1 Authenticated dashboard media route + conversation-view rendering of inbound/outbound images from the stored payload (`src/dashboard/data.ts` + UI), served only behind the dashboard auth gate (D-MM9).
- [ ] 5.2 Confirm message images render in the conversation view and that no media is reachable without the dashboard gate.

## 6. Verify end-to-end (attended)

- [ ] 6.1 Send Sunny a photo in a DM → it describes it (vision); send a PDF → it reads it; send an unsupported file → it reports the saved path and can open it via bash.
- [ ] 6.2 Ask Sunny to reply with an image (a file it produced) in a DM → received as an attachment; repeat in a group → received as a public link that resolves.
- [ ] 6.3 Confirm an attachment from an earlier turn still renders/loads after the Sendblue URL would have expired (durability), and that image bytes never appear in logs.
