# sunny-cli (delta)

## ADDED Requirements

### Requirement: Generic self-interaction CLI
The repo SHALL provide a single `sunny` CLI (subcommand-structured, repo-owned, runnable on the host via bash) as the composable surface for agent capabilities that operate on Sunny's own state — so new capabilities can ship as tested CLI subcommands documented by skills rather than as new native tools. Subcommand logic SHALL live in importable functions (unit/integration testable without spawning a process); the executable entry SHALL be a thin argument parser. The CLI SHALL read its database and configuration the same way the runtime does (env-file `DATABASE_URL`, shared config loader), and failures SHALL exit non-zero with a message written for a model to read and act on.

#### Scenario: A skill-driven job uses the CLI over bash
- **WHEN** a scheduled run holding the bash grant follows a skill that invokes a `sunny` subcommand
- **THEN** the subcommand runs against the live store and returns its output as the tool result

#### Scenario: Validation failures are actionable
- **WHEN** a subcommand's input fails a validation
- **THEN** it exits non-zero with a specific reason the model can correct from

### Requirement: Dream subcommands
The CLI SHALL provide the dreaming job's deterministic operations:
- `dream digest` SHALL emit all conversation messages since the global dream watermark (excluding internal `subagent:` inboxes and anything newer than the freshness margin), grouped per thread with speaker attribution, verbatim spoken text, attachment name+path lines, bounded tool-call traces, inter-message time-gap markers above a lull threshold (surfacing natural episode boundaries), each thread's prior compaction summary, and a suggested compaction boundary that leaves approximately the configured token target of verbatim tail — presented as a ceiling: the dream cuts at the nearest conversational seam at-or-before it; it SHALL emit the INDEX lint diff (topic files vs INDEX bullets, both directions) and the exact `advance` invocation for the digest's covered-through position; it SHALL enforce a global size cap by covering oldest-first and reporting a partial covered-through; and it SHALL print an idle marker when nothing is new.
- `dream compact` SHALL perform the compaction write with all validations owned by the context-compaction capability.
- `dream advance` SHALL upsert the global dream watermark to a given covered-through position.

#### Scenario: Digest covers exactly the unprocessed span
- **WHEN** `dream digest` runs after a prior dream advanced the watermark
- **THEN** only messages after the watermark (and older than the freshness margin) appear

#### Scenario: Idle digest short-circuits the dream
- **WHEN** no new messages exist since the watermark
- **THEN** `dream digest` prints the idle marker and the dreaming run ends without memory writes

#### Scenario: Size cap yields a partial watermark
- **WHEN** the unprocessed span exceeds the digest size cap
- **THEN** the digest covers the oldest content up to the cap and reports a covered-through position before the newest message, so the next dream continues from there
