## ADDED Requirements

### Requirement: Per-person profile documents
Sunny SHALL maintain a per-person profile document for each non-owner trusted person (family), stored as a markdown file under `~/.sunny/state/memory/people/<id>.md`, where `<id>` is a stable identifier derived from the person's identity. A person's profile document SHALL be auto-created on first contact if it does not already exist, and SHALL accumulate durable facts about that person as Sunny learns them, in the same files-first, version-controlled manner as the rest of memory. Durable facts about a specific person SHALL be written to that person's profile document rather than to the owner's `USER.md`. The owner's `USER.md` SHALL remain the model of the owner and SHALL be editable only by the owner (Sunny SHALL NOT modify `USER.md` on behalf of a non-owner sender).

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

## MODIFIED Requirements

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
