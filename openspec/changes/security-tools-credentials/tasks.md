> Build plan for the security / tools / credentials change (originally Phase 4 of
> `bootstrap-sunny`). The three capabilities ship together — the approval,
> command-permissioning, and credential-injection stories are one design. D-*
> decisions are in this change's `design.md`.

- [ ] 1 1Password setup: dedicated read-only `Sunny` vault + Service Account; `OP_SERVICE_ACCOUNT_TOKEN` from a hardened `EnvironmentFile`; `@1password/sdk` wrapper resolving `op://` refs in the tool layer only (D-CR1, D-CR2, D-CR4).
- [ ] 2 Approval tiers: smart risk-assessor on a **cheap fast model (Haiku-class)** + hard-gated categories (money / destructive / act-as-Devon); approvals **durable-suspended** (WDK hook) with an **id-correlated** reply, re-prompt on ambiguity, default-deny on timeout (security R: approval tiers, durable/correlated approvals; D-SEC3; R9, R10).
- [ ] 3 Owner tagging end-to-end: gateway tags `isOwner`; non-owner group messages are answerable but cannot trigger consequence or approve (security R: identity; messaging-gateway R: owner tagging; R1).
- [ ] 4 Hard blocklist (rm -rf /, fork bombs, reading the op token file, weakening own guards) (security R: hard blocklist; D-SEC4).
- [ ] 5 Command-permissioning (bash-centric, R13): deny-by-default allow/ask/deny policy matched on a **parsed command AST** (enumerate sub-commands across pipes/`$()`/chains; fail-closed); **skill-scoped command allowlists**; smart-mode triages the uncertain middle; per-command `op run` credential injection (`op://` → that subprocess's env only) (tool-access R: command permissioning, skill-scoped perms, per-command injection; D-TA1).
- [ ] 6 Taint-tracking + step-up auth (R14): mark whether a run's context contains untrusted content; **clean** commands run under the normal policy with full host access; **tainted** commands require **step-up "2FA"** (provenance-flagged confirmation + a real second factor — TOTP/passkey/out-of-band tap); **unattended** tainted commands block + defer to Devon (or targeted sandbox); **restrict egress** as a backstop regardless (tool-access R: taint-tracking + step-up; R14).
- [ ] 7 Thin tools (bash, file read, web fetch) + capabilities as skills: **`devbox` skill** for build/run/host sites (public deploy = ask/blocked command); **email skill** over himalaya for `sunny@waywardlane.com` (CC/forward to act; himalaya *send* hard-gated; bodies untrusted → injection-contained, ideally a no-credential subagent); research/todos as skills (R3, R5, R13).
- [ ] 8 Credentialed browser tool in an isolated profile with a **persistent logged-in profile** (cookie store treated as a credential surface — on the hard blocklist, never logged/read by other tools); fill logins from whitelisted refs at fill-time; credentialed actions approval-gated (security D-SEC4/5, tool-access R: browser routing, D-TA3; R6).
- [ ] 9 Prompt-injection containment: untrusted content treated as data, delimited, not followed (security R: untrusted-content-is-data; D-SEC6).
- [ ] 10 Crypto DM-pairing for identity (upgrade the bootstrap owner allowlist) (security R: command identity; D-SEC2).
- [ ] 11 Rotate the 1Password Service Account token on a schedule (credentials D-CR4 × scheduling).
- [ ] 12 End-to-end smoke test of the gated paths (send-email approval, credentialed browser, blocklist refusal) before relying on autonomy.
