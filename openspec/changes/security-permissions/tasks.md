> Build plan for the **security-permissions** change — the enforcement layer over the
> capabilities and declarations from `agent-tooling` (archive that change first). D-*
> decisions are in this change's `design.md`.

## Identity & approvals (security-permissions)
- [ ] 1 Crypto DM-pairing for identity, upgrading the bootstrap owner allowlist (D-SEC2).
- [ ] 2 Owner tagging end-to-end: gateway tags `isOwner`; non-owner group messages are answerable but cannot trigger consequence or approve (D-SEC2).
- [ ] 3 Approval tiers: smart risk-assessor on a cheap fast model (Haiku-class) + hard-gated categories (money / destructive / act-as-Devon); approvals **durable-suspended** (WDK) with an **id-correlated** reply, re-prompt on ambiguity, default-deny on timeout (D-SEC3).
- [ ] 4 Hard blocklist (rm -rf /, fork bombs, reading the op token file, reading the browser session/cookie store, weakening own guards) (D-SEC4).
- [ ] 5 Prompt-injection containment: untrusted content treated as data, delimited, not followed; high-consequence actions still gated (D-SEC6).
- [ ] 6 Audit logging of every tool invocation + secret access (secrets redacted) to observability; surface in the dashboard Tools/Skills directories (D-SEC7).

## Command-permissioning (tool-access enforcement)
- [ ] 7 Deny-by-default allow/ask/deny policy matched on a **parsed command AST** (enumerate sub-commands across pipes/`$()`/chains; fail-closed → uncertain becomes ask) (D-TA1a).
- [ ] 8 Skill-scoped command allowlists: an active skill pre-approves only its declared commands, within the deny baseline (D-TA1b).
- [ ] 9 Conservative/hard-gated defaults: unknown/destructive/money/act-as-owner commands are ask or deny regardless of smart-mode; wire the credentialed-action gate (himalaya `send`, credentialed browser actions) over the `agent-tooling` capabilities (D-TA1, D-SEC3).
- [ ] 10 Smart-mode triages only the uncertain "ask" middle; never the sole gate (D-TA1c).
- [ ] 11 Policy decides when a command may resolve `op://` refs via the `op run` injection mechanism built in `agent-tooling` (D-TA1e).

## Taint-tracking + step-up (tool-access enforcement)
- [ ] 12 Mark whether a run's context contains untrusted content; **clean** commands run under the normal policy with full host access; **tainted** commands require **step-up "2FA"** (provenance-flagged confirmation + a real second factor — TOTP/passkey/out-of-band tap) (D-TA taint).
- [ ] 13 **Unattended** tainted commands block + defer to Devon (or targeted sandbox); **restrict egress** as a backstop regardless (D-TA taint).

## Credential hardening (credentials)
- [ ] 14 Token hardening: root-owned `0600` `EnvironmentFile`, never repo/logs/context, on the hard blocklist (D-CR4 / D-SEC4).
- [ ] 15 Rotate the Service Account token on a schedule (D-CR4 × scheduling).

## Verify
- [ ] 16 End-to-end smoke test of the gated paths before relying on autonomy: send-email approval, credentialed browser action gate, blocklist refusal, a tainted-command step-up, and an unattended tainted command deferring to Devon.
