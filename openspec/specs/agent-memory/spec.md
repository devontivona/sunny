# agent-memory Specification

## Purpose
TBD - created by archiving change bootstrap-sunny. Update Purpose after archive.
## Requirements
### Requirement: Always-on core memory
Sunny SHALL maintain an always-on memory core, stored as human-readable markdown files under `~/.sunny/state/memory/`, loaded into context at the start of every message-handling run. The core SHALL consist of at least `USER.md` (the model of the owner), `SUNNY.md` (the agent's own operating notes), and `INDEX.md` (a router listing available topic documents); these SHALL be loaded on every run regardless of who sent the triggering message. In addition, for the non-owner trusted participants present in the current thread, Sunny SHALL load their per-person profile documents into context. Each core file SHALL have a configured maximum size.

#### Scenario: Core is loaded on every run
- **WHEN** Sunny begins handling an inbound message
- **THEN** it loads the current contents of `USER.md`, `SUNNY.md`, and `INDEX.md` into context before responding

#### Scenario: Present participants' profiles are loaded
- **WHEN** Sunny begins handling a message in a thread that includes one or more trusted family members
- **THEN** it also loads the profile document of each such participant present in the thread

#### Scenario: User facts and agent notes are kept separate
- **WHEN** Sunny records a durable fact about the owner (e.g. a preference or relationship)
- **THEN** it writes to `USER.md`, not `SUNNY.md`
- **WHEN** Sunny records a durable fact about a specific family member
- **THEN** it writes to that person's `people/<id>.md`, not `USER.md`
- **WHEN** Sunny records a learned operating convention about how it should behave
- **THEN** it writes to `SUNNY.md`, not `USER.md`

### Requirement: Memory write tool with forced consolidation on overflow
Sunny SHALL modify core memory through a write tool exposing `add`, `replace`, and `remove` actions and no `read` action. When a write would cause a core file to exceed its configured cap, the tool SHALL return an error instead of truncating or silently dropping content.

#### Scenario: Overflow forces consolidation
- **WHEN** a write to a capped core file would exceed its size limit
- **THEN** the tool returns an error identifying the over-cap file
- **AND** Sunny consolidates that file (merging, pruning, or promoting detail to a topic doc) before retrying

#### Scenario: No read action
- **WHEN** Sunny needs the current contents of the always-on core
- **THEN** it relies on the core already present in context, rather than calling a read action

### Requirement: On-demand topic documents
Sunny SHALL store deeper, unbounded knowledge in topic documents under `~/.sunny/state/memory/topics/`, referenced by `INDEX.md`. Topic documents SHALL be loaded into context only when a task indicates the topic is relevant, not on every run.

#### Scenario: Topic doc loaded on relevance
- **WHEN** a message relates to a topic listed in `INDEX.md`
- **THEN** Sunny reads the corresponding `topics/*.md` file
- **AND** topic documents not indicated as relevant are not loaded

#### Scenario: Promotion from core to topic doc
- **WHEN** detail in a core file is too large to retain there
- **THEN** Sunny moves that detail into the appropriate topic document and ensures `INDEX.md` references it

### Requirement: Date-tagged facts for temporal reasoning
Facts in topic documents that can change over time SHALL carry explicit date-range tags (e.g. `[2025-01 → 2025-06]`, `[2025-06 → present]`). When a fact is superseded, Sunny SHALL close the prior fact's date range and add the new fact rather than deleting history.

#### Scenario: Fact supersession preserves history
- **WHEN** a previously recorded dated fact becomes untrue (the user reports a change)
- **THEN** Sunny closes the open date range on the prior entry and adds a new dated entry
- **AND** the prior entry remains in the topic document

#### Scenario: Point-in-time query
- **WHEN** the user asks what was true at a past date
- **THEN** Sunny answers using the date-range tags on the relevant facts

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


### Requirement: Safe concurrent memory writes
Memory-file mutations from any source (conversational turns, durable jobs, scheduled consolidation) SHALL be serialized so that concurrent writers cannot corrupt or lose updates to the core files or topic documents. Reads SHALL observe a consistent snapshot at run start.

#### Scenario: Concurrent writers do not corrupt memory
- **WHEN** two processes attempt to mutate the same memory file at the same time
- **THEN** the writes are serialized and neither update is lost or corrupted

#### Scenario: Consistent read snapshot
- **WHEN** a run loads memory while another process is mid-write
- **THEN** the run observes a consistent snapshot, not a partial write

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


### Requirement: Files-first ownership and editability
All memory state except the message database SHALL be plain markdown files under `~/.sunny/state/memory/` that the user can read and hand-edit. The memory directory SHALL be the working tree of the `state` git repository, committed on every write so that history and backup are maintained automatically. Memory contents SHALL NOT be transmitted to any third-party LLM, analytics, or managed-memory service; they MAY be pushed to an owner-controlled private git backup remote (e.g. the `state` repository's remote), which is not considered third-party egress because the owner controls the destination and no service processes the contents.

#### Scenario: User hand-edits memory
- **WHEN** the user directly edits a memory markdown file
- **THEN** the next message-handling run reflects the edited contents
- **AND** no functionality depends on memory having been written only by Sunny

#### Scenario: Writes are captured in version history
- **WHEN** Sunny writes to a memory file via the memory tool
- **THEN** the change is committed to the `state` repository so the edit is recoverable from history

#### Scenario: No third-party egress
- **WHEN** memory is stored or recalled
- **THEN** memory contents are not sent to any managed/cloud memory service, LLM provider for storage, or analytics service
- **AND** the only permitted off-host destination is an owner-controlled private git backup remote

### Requirement: Local semantic recall upgrade path
The recall layer SHALL be structured so that semantic (vector) search can be added without changing the agent loop. When added, semantic search SHALL use `pgvector` within the same Postgres database and local embeddings, preserving the single-datastore, self-hosted, no-egress properties.

#### Scenario: Semantic search added in-place
- **WHEN** keyword recall is upgraded with semantic search
- **THEN** vectors are stored via `pgvector` inside the existing Postgres database
- **AND** embeddings are computed locally with no data sent to a third-party service
- **AND** the agent loop's recall interface is unchanged

### Requirement: Per-person profile documents
Sunny SHALL maintain a per-person profile document for each non-owner trusted person (family), stored as a markdown file under `~/.sunny/state/memory/people/<id>.md`, where `<id>` is a stable identifier derived from the person's identity. A person's profile document SHALL be auto-created on first contact if it does not already exist, and SHALL accumulate durable facts about that person as Sunny learns them, in the same files-first, version-controlled manner as the rest of memory. Durable facts about a specific person SHALL be written to that person's profile document rather than to the owner's `USER.md`. The owner-only core files — `USER.md` (the model of the owner) and `SUNNY.md` (Sunny's operating notes) — SHALL be editable only by the owner (Sunny SHALL NOT modify them on behalf of a non-owner sender). Family senders MAY still write their own `people/<id>.md`, topic documents, and `INDEX.md`.

#### Scenario: Profile auto-created on first contact
- **WHEN** a trusted family member contacts Sunny for the first time and has no profile document
- **THEN** Sunny creates `people/<id>.md` for that person

#### Scenario: Person facts routed to the person's document
- **WHEN** Sunny records a durable fact about a family member (e.g. a preference)
- **THEN** it writes the fact to that person's `people/<id>.md`
- **AND** does not write it to the owner's `USER.md`

#### Scenario: Owner profile is owner-edit-only
- **WHEN** a non-owner trusted sender's turn would record a fact about the owner
- **THEN** Sunny does not modify the owner's `USER.md` on that sender's behalf

### Requirement: Cross-thread keyword recall
Keyword recall over message history SHALL span all conversations (the owner's and family members' threads), not only the current thread, so Sunny can cross-reference what was said elsewhere. Recall results SHALL be attributed with who said each message and which conversation it was in, so Sunny can reference the source (e.g. "in your chat with Kate"). Recall SHALL be subject to the same cross-person discretion as the rest of memory.

#### Scenario: Recall finds a message from another thread
- **WHEN** the owner references a person or event that was discussed in a different thread
- **THEN** recall returns the matching messages from that other thread
- **AND** each result indicates who said it and which conversation it came from

#### Scenario: Recall results are attributed by conversation
- **WHEN** recall returns a hit from a family member's direct-message thread
- **THEN** the result names that family member's conversation rather than an opaque thread id

### Requirement: Discretion in cross-person disclosure
Because the owner's profile and other people's profiles may be present in context together, Sunny SHALL be instructed to use discretion about disclosing facts it knows about one person to another, rather than relying on withholding documents from context. The owner's profile MAY remain loaded in family-facing contexts so Sunny is not amnesiac about the owner; the safeguard against inappropriate disclosure SHALL be Sunny's judgment, guided by its operating instructions.

#### Scenario: Owner context available but disclosure is discretionary
- **WHEN** Sunny is handling a family member's message with the owner's profile in context
- **THEN** Sunny may use what it knows about the owner to be helpful
- **AND** uses discretion about repeating facts that would be inappropriate to share

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
