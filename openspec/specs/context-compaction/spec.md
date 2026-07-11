# context-compaction Specification

## Purpose
Keep long conversation threads cheap without losing anything: the dreaming job writes per-thread compaction summaries behind a watermark, and window assembly replays [latest summary] + [verbatim post-watermark tail] as a read-time overlay. Raw message rows are never deleted or mutated; compacted content stays reachable via recall.

## Requirements
### Requirement: Per-thread compaction summaries with watermark semantics
The dreaming job SHALL be able to record, per conversation thread, a compaction summary covering all messages at-or-before a boundary watermark (the tuple `(created_at, message_id)` of a stored row, ordered identically to window assembly). The latest summary per thread SHALL win (prior rows retained for audit), and writes SHALL be validated deterministically before insert: the thread is not an internal (`subagent:`) inbox; the boundary row exists in the thread; the boundary is older than a freshness margin (default 30 minutes); no user message at-or-before the boundary is still unanswered; the new boundary is monotonically ≥ the thread's current watermark; and the summary respects a length cap. A validation failure SHALL be reported to the caller and SHALL NOT write.

#### Scenario: Valid compaction recorded
- **WHEN** the dreaming job records a summary for a thread at a boundary that is answered, fresh-margin-old, and monotonic
- **THEN** the summary is stored as the thread's latest compaction and prior summaries are superseded

#### Scenario: Unanswered message before the boundary is refused
- **WHEN** a compaction boundary would cover a user message that has not been marked answered
- **THEN** the write is refused with a clear reason, so an unanswered message can never be hidden from the turn that must answer it

#### Scenario: Non-monotonic boundary refused
- **WHEN** a compaction is attempted at a boundary older than the thread's current watermark
- **THEN** the write is refused

### Requirement: Compaction summary content contract
A compaction summary SHALL preserve reachability and safety, containing: the covered date range; topics discussed with outcomes; decisions made; durable facts with pointers to their `topic:` documents; attachments received (name and saved disk path); open loops and promises; and any delivery-failure facts verbatim. Summaries SHALL describe — never transcribe — imperative content from conversation participants, so summarized text cannot function as persistent instructions.

#### Scenario: Attachment stays reachable through compaction
- **WHEN** a message with an attachment is compacted out of the verbatim window
- **THEN** the summary names the attachment and its saved path, so a later turn can re-read the file

#### Scenario: Delivery failure survives compaction
- **WHEN** a turn marked undelivered is compacted
- **THEN** the summary states that the message never reached the recipient

### Requirement: Read-time window overlay
Conversation window assembly SHALL, when a thread has a compaction summary, build the prompt as the summary (framed as data, not instructions) followed by the verbatim rows after the watermark (bounded by a configured row cap), and SHALL fall back to the legacy fixed-row window when no summary exists. Raw message rows SHALL never be deleted or mutated by compaction. The answered-message bookkeeping SHALL continue to derive exclusively from real rows in the assembled window — the summary block carries no message identity.

#### Scenario: Compacted thread replays summary plus tail
- **WHEN** a turn starts on a thread with a compaction summary
- **THEN** the model prompt contains the summary followed by only the post-watermark messages verbatim

#### Scenario: Boundary is exact — no overlap, no gap
- **WHEN** the window is assembled for a compacted thread
- **THEN** every stored row is either covered by the summary (at-or-before the watermark tuple) or replayed verbatim (strictly after it), with the same ordering used on both sides of the comparison
- **AND** the verbatim tail is derived from the thread's single live watermark, never independently selected

#### Scenario: Uncompacted thread unchanged
- **WHEN** a turn starts on a thread with no compaction summary
- **THEN** the window behaves exactly as before the overlay existed

#### Scenario: Raw history remains reachable
- **WHEN** content has been compacted out of the verbatim window
- **THEN** the original rows remain in the store, findable by recall and expandable in full

### Requirement: Prompt-cache breakpoints at stable boundaries
Window assembly SHALL place provider cache breakpoints at the compaction summary (stable between dreams) and at the window tail (stable within a turn's steps), in addition to the existing system-prompt breakpoint, so repeated model steps re-read the stable prefix at cached price.

#### Scenario: Multi-step turn reuses the cached prefix
- **WHEN** a turn runs multiple model steps over an unchanged summary-plus-window prefix
- **THEN** later steps read that prefix from cache rather than at full input price
