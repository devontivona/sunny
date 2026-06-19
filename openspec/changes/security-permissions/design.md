# Design — Security & Permissions (enforcement layer)

> The enforcement layer: consequence-gating, command-permissioning, taint/step-up, and
> credential hardening **on top of** the capabilities and declarations from the
> `agent-tooling` change.

## Sequencing

`agent-tooling` records each tool's risk tier + `op://` references (D-TA0) and builds
the tools ungated. This change adds the engine that **reads those declarations and
gates** — a wrapper around the existing tool surface, not a rewrite of it. Archive
`agent-tooling` first; this change makes its attended-only state safe for autonomy.

---

# Security & Permissions

## Context

Sunny has shell access to the home server, a browser that drives Devon's logged-in
sessions, the ability to read/send email, install/run skills, and self-scheduling —
while constantly reading **untrusted content** (web pages, emails, installed skills,
file contents) that can carry injected instructions. Prompt injection is not reliably
solvable, so we gate **consequences**.

## Goals / Non-Goals

**Goals:** contain the blast radius of a hijacked model (high-consequence actions
cannot happen without a hard rule or Devon's approval); make approvals a natural part
of the iMessage UX; keep secrets out of the model (plumbing in `agent-tooling`).

**Non-Goals:** preventing the model from being manipulated by injected content (assumed
impossible); full host sandboxing of every tool (Devon chose direct host access; only
the credentialed browser is isolated — and that isolation is built in `agent-tooling`).

## Decisions

- **D-SEC1 — Assume model compromise, gate consequences.** A hijacked Sunny still
  cannot take irreversible or credential-leaking action without a hard rule or human
  approval intervening. Every other decision derives from this.
- **D-SEC2 — Identity: only the paired user commands Sunny.** Cryptographic DM-pairing
  (extends `messaging-gateway` D-MG6) establishes that a sender is Devon. Only the paired
  identity can issue commands or grant approvals (upgrades the bootstrap owner allowlist).
- **D-SEC3 — Approval tiers: balanced "smart" mode, hard-gated categories.** AUTO (web
  fetch/search, read-only shell, draft, query memory, build a site), APPROVAL (send
  email, credentialed web actions, spend money, destructive/writing shell, public deploy,
  install a skill), FORBIDDEN (D-SEC4). A cheap risk-assessor (Haiku-class) may
  auto-approve the uncertain middle, **but money / destructive / act-as-Devon always
  prompt** regardless of its verdict. Approvals over iMessage (AI SDK `needsApproval`),
  durable-suspended (WDK), id-correlated, default-deny on timeout, owner-only.
- **D-SEC4 — Hard blocklist.** A fixed set of catastrophic actions always refused even
  with explicit approval: disk wipes, fork bombs, reading the 1Password token file,
  reading the credentialed browser's session/cookie store, exfiltrating a whole vault,
  weakening Sunny's own guardrails. The floor beneath the tiers.
- **D-SEC5 — Surface isolation.** Host access is direct except the credentialed browser,
  which runs in an isolated persistent profile — **that isolation is built in
  `agent-tooling` (D-TA3)**; here it underpins the containment model. Installed skills
  run directly; their *installation* is APPROVAL-gated (D-SEC3).
- **D-SEC6 — Prompt-injection containment.** Untrusted content is data, not instructions:
  delimited, not followed; high-consequence actions triggered while processing it still
  hit D-SEC3/D-SEC4. Containment, not prevention — the gates are the real defense.
- **D-SEC7 — Audit logging.** Every tool invocation and secret access is logged
  (secrets redacted) to the `observability` layer; feeds the dashboard's Tools/Skills
  directories built in `agent-tooling`.

---

# Tool Access (enforcement)

## Decisions

- **D-TA1 — Command-level permissioning (deny-by-default).** Because bash is the
  universal surface (D-TA2, `agent-tooling`), permissioning attaches to **commands**, not
  per-activity tools. Layers:
  - **(a) Command-approval policy** — deny-by-default allow/ask/deny on a **parsed
    command (AST)**, enumerating every sub-command across pipes/`$()`/chains, **fail-closed**
    (uncertain → ask). Patterns route; they are NOT a security boundary.
  - **(b) Skill-scoped allowlists** — an active skill pre-approves only the commands it
    needs, within the deny baseline ("permissioning in the skills layer").
  - **(c) Smart-mode triage** — a cheap model triages only the uncertain "ask" middle;
    never the sole gate.
  - **(d) Hard blocklist** — non-overridable, trips first (D-SEC4).
  - **(e) Per-command credentials** — `op run` injection (mechanism built in
    `agent-tooling` D-TA5); here the policy decides *when* a command may resolve refs.
- **Taint-tracking + step-up auth (not blanket sandboxing).** Blanket-sandboxing bash is
  self-defeating — Sunny needs real host access for devops on its own server. The risk is
  a command whose *construction was influenced by untrusted content*. So we track
  provenance:
  - **Clean commands** (Devon's direct instruction, no untrusted content in context) run
    under the normal allow/ask/deny policy with **full host access** — the devops path.
  - **Tainted commands** (produced with untrusted content in context) require **step-up
    ("2FA")**: a distinct high-friction confirmation showing the exact command and flagging
    its untrusted provenance, ideally a real second factor (TOTP/passkey/out-of-band tap).
  - **Unattended runs** can't step-up an absent human → a tainted command is **blocked and
    deferred to Devon**, or run in a targeted sandbox for that case only.
  - **Egress/network control** stays a cheap backstop regardless.
- **Credentialed-action gate.** Any act-as-owner action (credentialed browser action,
  email send) is approval-gated regardless of smart-mode — over the capabilities
  `agent-tooling` builds.

## Rejected alternatives

- **Detect/prevent prompt injection:** not reliable; replaced by consequence-gating.
- **Sandbox everything:** rejected for direct access + approval tiers + taint-gating;
  only the credentialed browser is isolated.
- **Minimal approval (autonomy-first):** too risky for a credentialed agent.

---

# Credentials (hardening)

- **D-CR4 — Token hardening + rotation.** The Service Account token (resolution plumbing
  in `agent-tooling` D-CR1-3) lives in a root-owned `0600` file (systemd `EnvironmentFile`),
  never in the repo or logs/context, on the hard blocklist (D-SEC4), and rotated on a
  schedule (reusing `scheduling`, since 1Password has no auto-expiry).

## Risks / Trade-offs

- **Smart-mode can be fooled:** mitigated by hard-gating high-consequence categories
  regardless of its verdict (D-SEC3).
- **Installed skills run with full host access:** residual risk accepted; mitigated by
  gating installs + preferring self-authored/reviewed skills (D-SK5/6 in `agent-tooling`).
- **Approval fatigue:** smart-mode + conservative-then-relax posture; tune over time.
- **Injection contained, not prevented:** a hijacked Sunny can still do anything in the
  AUTO tier; kept low-consequence by construction.
