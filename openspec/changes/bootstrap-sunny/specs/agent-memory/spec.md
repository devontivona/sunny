## ADDED Requirements

### Requirement: Always-on core memory
Sunny SHALL maintain an always-on memory core, stored as human-readable markdown files under `~/.sunny/memory/`, loaded into context at the start of every message-handling run. The core SHALL consist of at least `USER.md` (the model of the user), `SUNNY.md` (the agent's own operating notes), and `INDEX.md` (a router listing available topic documents). Each core file SHALL have a configured maximum size.

#### Scenario: Core is loaded on every run
- **WHEN** Sunny begins handling an inbound message
- **THEN** it loads the current contents of `USER.md`, `SUNNY.md`, and `INDEX.md` into context before responding

#### Scenario: User facts and agent notes are kept separate
- **WHEN** Sunny records a durable fact about the user (e.g. a preference or relationship)
- **THEN** it writes to `USER.md`, not `SUNNY.md`
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
Sunny SHALL store deeper, unbounded knowledge in topic documents under `~/.sunny/memory/topics/`, referenced by `INDEX.md`. Topic documents SHALL be loaded into context only when a task indicates the topic is relevant, not on every run.

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
Sunny SHALL persist all sent and received messages in a Postgres database with full-text (tsvector/GIN) indexing, and SHALL recall older history by keyword search. The matching results are returned to the agent, which summarizes them in its own context — there is no separate summarizer model or call. Message history SHALL NOT be auto-loaded into context in full.

#### Scenario: Recall older history by keyword
- **WHEN** Sunny needs information from beyond the recent rolling message window
- **THEN** it runs a full-text keyword search over message history and the agent summarizes the matching results in context
- **AND** does not load the entire history into context

#### Scenario: Recent window plus recall
- **WHEN** handling a message in a long-running thread
- **THEN** Sunny keeps a bounded window of recent messages verbatim in context and relies on keyword recall for anything older

### Requirement: Safe concurrent memory writes
Memory-file mutations from any source (conversational turns, durable jobs, scheduled consolidation) SHALL be serialized so that concurrent writers cannot corrupt or lose updates to the core files or topic documents. Reads SHALL observe a consistent snapshot at run start.

#### Scenario: Concurrent writers do not corrupt memory
- **WHEN** two processes attempt to mutate the same memory file at the same time
- **THEN** the writes are serialized and neither update is lost or corrupted

#### Scenario: Consistent read snapshot
- **WHEN** a run loads memory while another process is mid-write
- **THEN** the run observes a consistent snapshot, not a partial write

### Requirement: Self-scheduled memory consolidation
Sunny SHALL run a recurring, self-scheduled consolidation job that reviews recent raw message history and updates topic documents and core files, so that memory hygiene does not depend on the user managing it.

#### Scenario: Nightly consolidation runs
- **WHEN** the scheduled consolidation job fires
- **THEN** Sunny reviews the recent message history and updates topic documents and/or core files with durable facts
- **AND** the update respects the core file caps (consolidating as needed)

### Requirement: Files-first ownership and editability
All memory state except the message database SHALL be plain markdown files under `~/.sunny/memory/` that the user can read and hand-edit. The memory directory SHALL be compatible with version control for history and backup. The system SHALL NOT transmit memory contents to any third-party service.

#### Scenario: User hand-edits memory
- **WHEN** the user directly edits a memory markdown file
- **THEN** the next message-handling run reflects the edited contents
- **AND** no functionality depends on memory having been written only by Sunny

#### Scenario: No third-party egress
- **WHEN** memory is stored or recalled
- **THEN** memory contents remain on the local host and are not sent to any managed/cloud memory service

### Requirement: Local semantic recall upgrade path
The recall layer SHALL be structured so that semantic (vector) search can be added without changing the agent loop. When added, semantic search SHALL use `pgvector` within the same Postgres database and local embeddings, preserving the single-datastore, self-hosted, no-egress properties.

#### Scenario: Semantic search added in-place
- **WHEN** keyword recall is upgraded with semantic search
- **THEN** vectors are stored via `pgvector` inside the existing Postgres database
- **AND** embeddings are computed locally with no data sent to a third-party service
- **AND** the agent loop's recall interface is unchanged
