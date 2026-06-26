## MODIFIED Requirements

### Requirement: Always-on core memory
Sunny SHALL maintain an always-on memory core, stored as human-readable markdown files under `~/.sunny/state/memory/`, loaded into context at the start of every message-handling run. The core SHALL consist of at least `USER.md` (the model of the user), `SUNNY.md` (the agent's own operating notes), and `INDEX.md` (a router listing available topic documents). Each core file SHALL have a configured maximum size.

#### Scenario: Core is loaded on every run
- **WHEN** Sunny begins handling an inbound message
- **THEN** it loads the current contents of `USER.md`, `SUNNY.md`, and `INDEX.md` into context before responding

#### Scenario: User facts and agent notes are kept separate
- **WHEN** Sunny records a durable fact about the user (e.g. a preference or relationship)
- **THEN** it writes to `USER.md`, not `SUNNY.md`
- **WHEN** Sunny records a learned operating convention about how it should behave
- **THEN** it writes to `SUNNY.md`, not `USER.md`

### Requirement: On-demand topic documents
Sunny SHALL store deeper, unbounded knowledge in topic documents under `~/.sunny/state/memory/topics/`, referenced by `INDEX.md`. Topic documents SHALL be loaded into context only when a task indicates the topic is relevant, not on every run.

#### Scenario: Topic doc loaded on relevance
- **WHEN** a message relates to a topic listed in `INDEX.md`
- **THEN** Sunny reads the corresponding `topics/*.md` file
- **AND** topic documents not indicated as relevant are not loaded

#### Scenario: Promotion from core to topic doc
- **WHEN** detail in a core file is too large to retain there
- **THEN** Sunny moves that detail into the appropriate topic document and ensures `INDEX.md` references it

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
