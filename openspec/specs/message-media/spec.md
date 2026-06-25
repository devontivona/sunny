# message-media Specification

## Purpose
TBD - created by archiving change messaging-media. Update Purpose after archive.
## Requirements
### Requirement: Inbound media reaches the model best-effort
Inbound message attachments SHALL be delivered to the model as content, not dropped. The system
SHALL map each attachment by type: images SHALL be provided as visual input, PDFs SHALL be
provided as document input, and any attachment type the model cannot ingest SHALL be made
available to the model as a saved file referenced by its local path and MIME type so it can be
operated on with the host tools. No attachment SHALL be silently discarded. The number and size of
attachments inlined into the model context MAY be capped; an attachment that exceeds a cap SHALL
still be saved and referenced rather than dropped.

#### Scenario: Image is seen as vision
- **WHEN** the owner sends a photo
- **THEN** the image is provided to the model as visual input it can describe or reason over

#### Scenario: PDF is read as a document
- **WHEN** an inbound message includes a PDF
- **THEN** the PDF is provided to the model as document input

#### Scenario: Unsupported type is surfaced, not dropped
- **WHEN** an inbound message includes a file the model cannot directly ingest (e.g. a video or archive)
- **THEN** the file is saved and the model is told its local path and type so it can act on it with the host tools

### Requirement: Inbound media is persisted durably
Because the transport's media URLs are short-lived, the system SHALL fetch attachment bytes
promptly on receipt and persist them on the host. Persisted media SHALL survive conversation
history replay and crash-before-processing recovery, so an attachment from an earlier turn remains
available without depending on the original transport URL. A failure to fetch one attachment SHALL
NOT drop the rest of the message.

#### Scenario: Attachment survives history replay
- **WHEN** a turn that included an attachment is replayed from history later
- **THEN** the attachment is still available from the persisted copy, not re-fetched from an expired URL

#### Scenario: Fetch failure is non-fatal
- **WHEN** one attachment cannot be fetched
- **THEN** the message is still processed with its text and any other attachments, and the failure is noted

### Requirement: Inbound media is untrusted
Attachment content — including any text rendered inside an image — SHALL be treated as untrusted
data, never as instructions. Attachment bytes SHALL NOT be written to logs; only metadata (name,
type, size) MAY be logged, subject to the existing content-logging control.

#### Scenario: Instructions inside an image are not obeyed
- **WHEN** an inbound image contains text that reads like a command
- **THEN** the model treats it as data and does not act on it as an instruction

### Requirement: Outbound image send
Sunny SHALL be able to attach a single image to an outbound message, identified by a local file
path it produced or by a URL. In a direct-message thread the image SHALL be delivered as a native
attachment with the message text as its caption. The model SHALL reference the image by path or
URL and SHALL NOT handle the raw bytes. Sending more than one image SHALL be expressed as more than
one send.

#### Scenario: Reply with an image in a DM
- **WHEN** Sunny replies in a DM with an image path and caption text
- **THEN** the recipient receives the image as an attachment with the caption

#### Scenario: One image per send
- **WHEN** Sunny needs to send several images
- **THEN** it sends them as separate messages

### Requirement: Outbound media hosting
Delivering a locally-produced image SHALL be done by publishing the file at a publicly fetchable
URL on the host's existing public endpoint, so the transport can fetch it server-side. The hosting
route SHALL serve only files explicitly published for sending, addressed by an unguessable token
(never by a caller-supplied path), and published files SHALL be removed after a bounded lifetime.
An image already given as a public URL SHALL be sent as-is without re-hosting.

#### Scenario: Local file is published for the transport to fetch
- **WHEN** Sunny sends a local image file
- **THEN** the file is published at an unguessable URL the transport can fetch, and is removed after its lifetime

#### Scenario: Published route serves only published files
- **WHEN** a request arrives for the media route with a token that does not map to a published file
- **THEN** no file is served and no other path on disk is reachable through the route

### Requirement: Group threads receive a media link
When Sunny would send an image to a group thread it SHALL instead post the publicly hosted media
URL as text, because native media send is unavailable on group threads. Receiving images from
group threads SHALL work the same as in direct messages.

#### Scenario: Image to a group becomes a link
- **WHEN** Sunny sends an image to a group thread
- **THEN** it posts the public media URL as text rather than failing to attach

#### Scenario: Group inbound image is ingested
- **WHEN** an image is received in a group thread Sunny participates in
- **THEN** the image reaches the model as visual input like a direct-message image

