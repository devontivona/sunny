## Why

Sunny runs today with full host trust and only an allowlisted owner identity — no consequence gating, no secret management, and only thin/placeholder tools. Before it can safely act on Devon's behalf (run commands, browse with his credentials, send email, spend money) it needs an assume-compromise security model, credential isolation, and a permissioned tool layer.

## What Changes

Add the **security-permissions**, **credentials**, and **tool-access** capabilities (originally Phase 4 of `bootstrap-sunny`) as one coupled change — the approval, command-permissioning, and credential-injection stories are a single design. Approval tiers + hard blocklist + owner/identity gating; a 1Password Service Account so the LLM never sees secret values (only `op://` references); a deny-by-default command-permissioning layer with taint-tracking + step-up auth; and the first real tools (bash, file read, web fetch, credentialed browser, email) exposed as gated capabilities/skills.

## Capabilities

### New Capabilities
- **security-permissions** — assume-compromise; gate consequences: approval tiers (cheap risk-assessor + hard-gated categories), hard blocklist, prompt-injection containment, crypto DM-pairing identity.
- **credentials** — 1Password Service Account; secrets resolved from `op://` references in the tool layer only, never exposed to the model.
- **tool-access** — per-tool risk tiers; command-permissioning (parsed command AST, skill-scoped allowlists, per-command `op run` injection); taint-tracking + step-up auth; credentialed browser routing.

## Impact

Unblocks autonomous action with safety. Builds on the bootstrapped foundation (messaging-gateway, durable-execution, scheduling). Pairs with the **observability** change (audit log, budget caps) and the **subagents** change (delegating untrusted-content processing to a no-credential child).
