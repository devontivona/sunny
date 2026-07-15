## ADDED Requirements

### Requirement: Outbound text passes through the short-link rewrite
All outbound message text SHALL pass through the short-link rewrite (per the `short-links` capability) inside the Sendblue transport driver immediately before handing text to the adapter, so that every outbound lane — terminal replies, recovery backstop, translator progress updates, proactive/scheduled sends, undeliverable-person notices, and the group-thread image-URL append — is covered by one seam. The rewrite SHALL occur after all other text finalization (e.g. media-URL appends) so no later step reintroduces long URLs. Persisted transcript history SHALL retain the original long URLs; only the wire text carries short links.

#### Scenario: Group image append is shortened
- **WHEN** an image is sent to a group thread and the driver appends the public media URL as plaintext
- **THEN** the appended URL is delivered as a short link

#### Scenario: Transcript keeps the original URL
- **WHEN** a reply containing a long URL is delivered as a short link
- **THEN** the persisted turn history and model-facing context contain the original long URL, not the short link
