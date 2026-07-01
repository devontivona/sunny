## MODIFIED Requirements

### Requirement: Configurable output target
Every durable run SHALL be addressed by an **Audience** (the run-audiences capability) — `person`, `household` (agent-choice or silent), `thread`, or `parent` — rather than a fixed `user`/`parent`/`silent` output target. The run's output SHALL be delivered by resolving its Audience to a bound delivery thread through the messaging gateway; a `household(silent)` (or otherwise silent) run SHALL send no proactive message and SHALL still record its result; a `parent` run's messages SHALL be delivered to its spawning run.

#### Scenario: Silent maintenance job sends nothing
- **WHEN** a silent run (e.g. nightly memory consolidation) completes
- **THEN** no proactive message is sent, and its result is still recorded for later inspection

#### Scenario: Delegated child reports to its parent
- **WHEN** a run with a `parent` audience sends a message
- **THEN** the message is delivered to its spawning run, not to a human

#### Scenario: Run reports to its audience, not always the owner
- **WHEN** a run with a `person` audience completes with a result
- **THEN** the result is delivered to that person's conversation via the gateway, even if that person is not the owner

### Requirement: Least-privilege child runs
Every **spawned** run — a delegated child, a background job, or a scheduled run — SHALL be endowed an authority (tools + credential references) that is a subset of its creator's, never broader, granted explicitly at spawn with no ambient inheritance. All spawned-run actions SHALL pass through the same tool-access gating, approval tiers, and blocklist as the creator. A spawned run SHALL NOT resolve a credential reference its creator could not, nor invoke a tool it was not endowed even if that tool exists in-process.

#### Scenario: Spawned run cannot exceed creator permissions
- **WHEN** a spawned run attempts an action or credential resolution its creator could not perform
- **THEN** it is refused

#### Scenario: Untrusted-content child is powerless
- **WHEN** Sunny delegates processing of untrusted content
- **THEN** it can grant the child no credentials and no high-consequence tools

#### Scenario: Endowment is explicit, not ambient
- **WHEN** a spawned run was not endowed a given tool grant
- **THEN** it cannot invoke that tool even though the tool is registered in the process
