## ADDED Requirements

### Requirement: Command-level permissioning (deny-by-default)
Capability is exposed primarily through a small tool surface (notably a shell/bash tool plus a few genuinely non-CLI tools), so permissioning SHALL be applied at the level of the command being run, not by proliferating one tool per permissioned activity. A deny-by-default command-approval policy SHALL classify each command as allow / ask / deny. Classification SHALL be based on a parsed representation of the command (not naive prefix string-matching), evaluating every sub-command across pipes, substitutions, and chaining, and SHALL fail closed (anything unparseable, substitution-bearing, or otherwise uncertain becomes ask, never allow).

#### Scenario: Safe command runs without prompting
- **WHEN** a command matches an allow rule and contains no unresolved substitution or chained un-allowed sub-command
- **THEN** it runs without prompting

#### Scenario: Chained or substituted command is not auto-allowed
- **WHEN** a command pipes, chains, or substitutes into a sub-command that is not itself allowed
- **THEN** it is not auto-allowed (it escalates to ask or is denied)

#### Scenario: Uncertain command fails closed
- **WHEN** a command cannot be confidently classified
- **THEN** it is treated as ask, not allow

### Requirement: Skill-scoped command permissions
An active skill MAY declare the command scopes it needs, pre-approving only those commands while it is active. Such declarations SHALL grant within the deny-by-default baseline, never remove the baseline gating for commands outside the declared scope.

#### Scenario: Skill pre-approves its own commands
- **WHEN** a skill declares the commands it uses and is active
- **THEN** those commands may run without prompting
- **AND** commands outside the declared scope are still gated by the baseline policy

### Requirement: Conservative defaults and hard-gated categories
Commands whose risk is unknown, or that are destructive, irreversible, money-spending, or act-as-the-owner (e.g. sending email, credentialed web actions), SHALL be ask or denied, never auto, regardless of the smart risk-assessor's verdict.

#### Scenario: Act-as-owner command is hard-gated
- **WHEN** a command sends email or performs a credentialed action on the owner's behalf
- **THEN** it requires owner approval first

### Requirement: Per-command credential injection
Secrets SHALL be injected into the specific command invocation that needs them (resolving `op://` references into that subprocess's environment at execution time), and SHALL NOT be exposed to the model or placed in the model's context. A command SHALL only receive credential references explicitly permitted for it (or its skill).

#### Scenario: Secret bound to one command only
- **WHEN** a command needs a credential
- **THEN** the value is resolved into that subprocess's environment at run time
- **AND** is not visible to the model or to other commands

### Requirement: Taint-tracking and step-up authorization for untrusted-derived commands
Sunny SHALL track whether a command's construction was influenced by untrusted content (web pages, email bodies, installed-skill output). Commands with no such influence ("clean") MAY run under the normal command policy with full host access. Commands so influenced ("tainted") SHALL require step-up authorization: a high-friction confirmation that shows the command and flags its untrusted provenance, distinct from an ordinary in-band approval. In unattended runs (no human available to authorize), a tainted command SHALL be blocked and deferred to the owner, or confined to a targeted sandbox. Network egress SHALL be restricted as a backstop regardless.

#### Scenario: Clean command keeps host access
- **WHEN** Sunny runs a command derived from the owner's direct instruction with no untrusted content in context
- **THEN** it runs under the normal command policy without step-up

#### Scenario: Tainted command requires step-up
- **WHEN** Sunny is about to run a command produced while untrusted content was in context
- **THEN** it requires step-up authorization showing the command and its untrusted provenance

#### Scenario: Tainted command in an unattended run
- **WHEN** a tainted command arises during a scheduled/autonomous run with no human to authorize
- **THEN** it is blocked and deferred to the owner (or confined to a targeted sandbox), not run with full host access

### Requirement: Credentialed browser tool routing
The credentialed browser tool SHALL run through the isolated browser profile, SHALL resolve site logins only from its whitelisted references at fill-time within the automation layer, and SHALL treat any credentialed action as approval-required.

#### Scenario: Login filled without exposing the value
- **WHEN** the browser tool authenticates to a site
- **THEN** it resolves the login from its whitelisted reference and fills it in the automation layer
- **AND** the value is not exposed to the model

#### Scenario: Credentialed action gated
- **WHEN** the browser tool performs an action on a logged-in site on the user's behalf
- **THEN** it requires user approval first
