## Why

A core part of Sunny's vision is that it can **install, write, and learn its own skills** — modular, file-based units of procedure that teach it how to do things — rather than having every capability hard-coded. This keeps the always-on prompt lean (progressive disclosure) and lets Sunny grow over time.

## What Changes

Add the **agent-skills** capability (originally Phase 5 of `bootstrap-sunny`): a `SKILL.md` loader (agentskills.io format) from `~/.sunny/skills/` with progressive disclosure (metadata index on the cached prefix, body loaded on trigger); a self-authoring `skill_manage` tool; and a gated installed-skill path via `npx skills add owner/repo`, with installed skills treated as untrusted and run under the tool-access gating.

## Capabilities

### New Capabilities
- **agent-skills** — `SKILL.md` standard; progressive disclosure; self-authoring with validation; gated installs treated as untrusted (no privilege escalation — `allowed-tools` only restricts).

## Impact

Depends on the **security-tools-credentials** change (installed/authored skills run under command-permissioning and tool gating; they must not escalate privilege). Optional `pgvector` retrieval over skill descriptions reuses the agent-memory semantic-recall upgrade path once the metadata budget is exceeded.
