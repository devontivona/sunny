## Why

The `agent-tooling` change gives Sunny real capabilities — bash, a credentialed browser, email, self-installing skills — and the 1Password plumbing to authenticate them, but **ungated**: it records each tool's risk tier and `op://` references without anything enforcing them, safe only under attended testing. Before Sunny can act autonomously on Devon's behalf (run commands, browse with his sessions, send email, spend money), it needs the **enforcement layer**: an assume-compromise security model that gates consequences, hardens credentials, and makes the recorded declarations binding.

## What Changes

Layer security and permissions **on top of** the capabilities from `agent-tooling`, reading the same declarations it records:

- **security-permissions** — assume-compromise consequence-gating: approval tiers (cheap risk-assessor + hard-gated money/destructive/act-as-owner categories), a hard blocklist (floor beneath approvals), durable + identity-correlated approvals over iMessage, crypto DM-pairing identity, prompt-injection containment, and audit logging.
- **tool-access (enforcement)** — the deny-by-default command-permissioning policy (parsed-AST allow/ask/deny, fail-closed), skill-scoped command allowlists, conservative/hard-gated defaults, **taint-tracking + step-up auth** for untrusted-derived commands, and the credentialed-action approval gate. These make the `agent-tooling` tool-registration contract (D-TA0) binding.
- **credentials (hardening)** — Service Account token hardening + scheduled rotation; the token file on the hard blocklist.

## Capabilities

### New Capabilities
- **security-permissions** — assume-compromise consequence-gating: approval tiers, hard blocklist, durable/correlated approvals, DM-pairing identity, injection containment, audit logging.

### Modified Capabilities
- **tool-access** — add the enforcement layer (command-permissioning AST policy, skill-scoped allowlists, taint-tracking + step-up, credentialed-action gate) over the contract and tools introduced by `agent-tooling`.
- **credentials** — add token hardening + scheduled rotation over the resolution plumbing introduced by `agent-tooling`.

## Impact

**Depends on `agent-tooling`** (enforces the contract and gates the tools it builds; archive `agent-tooling` first). Extends `messaging-gateway` (owner tagging, approvals over iMessage), `scheduling` (token rotation), and the `observability` change (audit log, budget caps). Pairs with `subagents` (delegate untrusted-content processing to a no-credential child). After this change, autonomous action is unblocked with safety.
