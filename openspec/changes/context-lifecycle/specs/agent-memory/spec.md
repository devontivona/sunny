# agent-memory (delta)

## MODIFIED Requirements

### Requirement: Keyword recall over message history
Sunny SHALL persist all sent and received messages in a Postgres database with full-text (tsvector/GIN) indexing, and SHALL recall older history by keyword search. The indexed text projection SHALL include, in addition to spoken/narration text, a sanity-bounded extract of each turn's tool-result text (binary/base64 content stripped, per-result and per-row caps under the tsvector limit) — so facts Sunny *read* (emails, documents, fetched pages) are findable, not only facts it *said*. Recall results SHALL be displayed as match snippets (headline excerpts) with date, speaker, thread, message id, and any attachment names + saved paths — never whole stored rows — and Sunny SHALL be able to deep-fetch one identified row in full (spoken text, tool outputs, attachment paths; length-capped) via a `recall_expand` affordance. Message history SHALL NOT be auto-loaded into context in full.

#### Scenario: Recall older history by keyword
- **WHEN** Sunny needs information from beyond the recent window
- **THEN** it runs a full-text keyword search and receives attributed snippets it can summarize in context
- **AND** does not load the entire history into context

#### Scenario: Tool-derived fact is findable
- **WHEN** a fact was read from an email or document in a past turn's tool output
- **THEN** a keyword search matching that fact returns a snippet from the turn that read it

#### Scenario: Snippet expands to the full row
- **WHEN** a recall snippet looks load-bearing
- **THEN** Sunny fetches that single row in full via `recall_expand` using the id shown in the snippet

#### Scenario: Attachment paths surface in recall
- **WHEN** a recalled message carried attachments
- **THEN** the result lists each attachment's name and saved disk path so the file can be re-read

### Requirement: Self-scheduled memory consolidation
Sunny SHALL run a recurring, self-scheduled **dreaming** job (every few hours; default 4h) that reads a time-ordered digest of ALL conversation activity since the last dream watermark — not a keyword guess — and updates memory accordingly: durable facts into USER.md and `people:` profile docs, operating conventions into SUNNY.md, deeper detail into topic documents, and reconciliation of the topic/INDEX linkage (adding missing hooks, upgrading stubs, removing stale lines). The job SHALL also write per-thread compaction summaries (see the context-compaction capability). The job SHALL be idle-cheap (when nothing is new since the watermark it ends without memory writes), SHALL advance its watermark only after processing so a failed dream reprocesses its span, and SHALL merge rather than re-add when it re-sees content. Its procedure SHALL be expressed as a skill executed by a plain scheduled run over bash + the `sunny` CLI, not as bespoke harness machinery.

#### Scenario: Dream folds recent conversation into memory
- **WHEN** the dreaming job fires after new conversation activity
- **THEN** it reads the digest of messages since the last watermark and updates core files, people docs, and/or topic docs with durable facts
- **AND** the update respects the core file caps (consolidating as needed)

#### Scenario: Idle dream is cheap
- **WHEN** the dreaming job fires with nothing new since the watermark
- **THEN** it records an idle outcome without writing memory

#### Scenario: Failed dream loses nothing
- **WHEN** a dream run fails before advancing its watermark
- **THEN** the next dream re-reads the same span and merges without duplicating memory content

## ADDED Requirements

### Requirement: Topic-INDEX linkage is a write-path invariant
Writing a topic document SHALL deterministically ensure INDEX.md contains a routing line for that topic (appending a stub hook when missing, in the same serialized write), so a topic can never exist undiscoverable. The dreaming job SHALL upgrade stub hooks into descriptive ones.

#### Scenario: New topic is immediately discoverable
- **WHEN** a topic document is written for a name absent from INDEX.md
- **THEN** INDEX.md gains a line for it in the same write, without relying on the model to remember

#### Scenario: Existing line untouched
- **WHEN** a topic document is written for a name already listed in INDEX.md
- **THEN** the existing INDEX line is not modified

### Requirement: Persisted attachments are permanently readable
Every inbound attachment SHALL persist at a stable disk path, surfaced in the attachment's rendered note and in recall results, and prompt guidance SHALL state that these files remain readable at any time (inline re-read for viewable types; host tooling such as pdftotext for documents). Guidance SHALL NOT claim files are unreachable.

#### Scenario: Old attachment re-read instead of re-requested
- **WHEN** the user references a file sent well before the current window
- **THEN** Sunny locates its saved path (via the window note or recall) and reads it, rather than asking the user to re-send it
