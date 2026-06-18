# Design — Security, Tools & Credentials

> Carved out of the `bootstrap-sunny` change (originally Phase 4). Covers the
> security-permissions, credentials, and tool-access capabilities, which are
> tightly coupled (one approval/permission/credential story).

# Security & Permissions

## Context (security-permissions)

Sunny has shell access to the home server, a browser that drives Devon's logged-in sessions, the ability to read/send email, install and run skills, and self-scheduling — while constantly reading **untrusted content** (web pages, emails, installed skills, file contents) that can carry injected instructions. Prompt injection is not reliably solvable.

## Goals / Non-Goals (security-permissions)

**Goals:**
- Contain the blast radius of a hijacked model: high-consequence actions cannot happen without a hard rule or Devon's approval stopping them.
- Make approvals a natural part of the iMessage UX.
- Keep secrets out of the model entirely (detailed in `credentials`).

**Non-Goals:**
- Preventing the model from being manipulated by injected content (assumed impossible; we gate consequences instead).
- Full host sandboxing of every tool (Devon chose direct host access; only the credentialed browser is isolated).

## Decisions (security-permissions)

### D-SEC1 — Core principle: assume model compromise, gate consequences

The security model assumes any untrusted content may hijack Sunny's reasoning, and ensures a hijacked Sunny still cannot take irreversible or credential-leaking action without a hard rule or human approval intervening. Every other decision derives from this.

### D-SEC2 — Identity: only the paired user commands Sunny

Inbound commands are authorized at the gateway (extends `messaging-gateway` D-MG6): cryptographic DM-pairing establishes that a sender is Devon. Only the paired identity can issue commands or grant approvals.

### D-SEC3 — Approval tiers: balanced "smart" mode, with hard-gated categories

Actions are classified into three gates:

```
  AUTO (no prompt)        APPROVAL (text Devon first)        FORBIDDEN (hard block)
  web search/fetch        send email                          rm -rf /, fork bombs,
  read-only shell         credentialed web actions            disk wipes
  read non-secret files   spend money / purchase              read the op token file
  build a site (devbox)   destructive/writing shell           disable own guardrails
  draft (not send)        public deploy                       exfiltrate whole vault
  query memory            install a skill                     raw secret → unapproved dest
```

A "smart" risk-assessor (an auxiliary LLM judgment) may auto-approve likely-safe actions to reduce friction, **but the APPROVAL categories above are hard-gated regardless of what smart-mode concludes** — money, destructive/irreversible, and "acting as Devon" (send email, credentialed web) always prompt. Approvals are delivered over iMessage (AI SDK v6 `needsApproval`); only the paired identity (D-SEC2) can approve; approvals default-deny on timeout.

### D-SEC4 — Hard blocklist

A fixed blocklist of catastrophic actions is always refused regardless of approval mode or even an explicit approval (e.g. wiping disks, fork bombs, reading the 1Password token file, weakening Sunny's own security configuration). This is the floor beneath the approval tiers.

### D-SEC5 — Surface isolation: credentialed browser isolated; host otherwise direct

Per Devon's choice, host access is direct except the **credentialed browser**, which runs in an **isolated browser profile/process** so a prompt-injected page cannot reach the broader host or other sessions. **Installed skills run directly** (not sandboxed) — accepted because skill **installation** is an APPROVAL-gated action (D-SEC3) and Sunny prefers self-authored skills and review-before-enable for anything from `skills.sh`.

### D-SEC6 — Prompt-injection containment

Untrusted content (web pages, email bodies, skill files, context files) is treated as **data, not instructions**. Content is clearly delimited as untrusted in prompts; Sunny does not follow instructions embedded in fetched/read content; high-consequence actions triggered while processing untrusted content still hit D-SEC3/D-SEC4. (Containment, not prevention — the gates are the real defense.)

### D-SEC7 — Audit logging

Every tool invocation and every secret access is logged (with secrets redacted) to the `observability` layer, so Devon can review what Sunny did and touched. Native 1Password access auditing requires a Business plan; Sunny's own audit log does not depend on it.

### Rejected alternatives (security-permissions)

- **Rely on detecting/preventing prompt injection:** not reliably possible; would create false confidence. Replaced by consequence-gating (D-SEC1).
- **Sandbox everything (sandbox-first):** rejected by Devon in favor of direct access + approval tiers; only the credentialed browser is isolated (D-SEC5).
- **Minimal approval (autonomy-first):** too risky for a credentialed agent; "acting as Devon" and money/destructive stay gated.

## Risks / Trade-offs (security-permissions)

- **Smart-mode can be fooled:** mitigated by hard-gating the high-consequence categories regardless of its verdict (D-SEC3).
- **Installed skills run with full host access (D-SEC5):** residual risk accepted; mitigated by gating installs and preferring self-authored/reviewed skills. Revisit if skill installs from registries become common.
- **Approval fatigue:** too many prompts erode attention. Smart-mode and a conservative-then-relax posture mitigate; tune over time.
- **Injection is contained, not prevented:** a hijacked Sunny can still do anything in the AUTO tier. Kept low-consequence by construction.

---

# Credentials

## Context (credentials)

Devon stores secrets in 1Password and wants to use 1Password's own tooling rather than a custom vault. Sunny (TypeScript, headless Linux) needs to read API keys at runtime and, later, authenticate a browser session — without exposing secrets to the LLM or to plaintext config.

Key 1Password facts (from research): the official **TS SDK** (`@1password/sdk`) authenticates with a **Service Account** token and resolves `op://` references to values in-process; **Service Accounts cannot access the user's Private vault or the default Shared vault** (so a dedicated vault is required *and* this restriction is a safety feature); there is **no sub-vault/per-item scoping** (the vault is the blast-radius boundary); the token **is a master key** to its scoped vault(s).

## Goals / Non-Goals (credentials)

**Goals:**
- The LLM never receives secret values.
- "Sunny can't read my real creds" is literally true for everything outside a dedicated minimal vault.
- Low-friction curation of what Sunny can access (drag/copy items in the 1Password UI).

**Non-Goals:**
- Per-item access control inside a vault (doesn't exist in 1Password; use the vault boundary).
- Hiding values from Sunny's *process* (impossible — the process must read values to use them; the protection is scoping + not exposing to the model).

## Decisions (credentials)

### D-CR1 — Dedicated minimal `Sunny` vault + read-only Service Account

A new dedicated `Sunny` vault holds only what Sunny needs. A read-only Service Account (`read_items`) scoped to just that vault provides access via `OP_SERVICE_ACCOUNT_TOKEN`. Everything outside the Sunny vault is unreadable by construction (reinforced by 1Password forbidding Service-Account access to the Private vault). Devon populates the vault by copying items via the 1Password UI (Copy, not Move, for creds he also uses).

### D-CR2 — The model sees references, never values

Sunny's reasoning model only ever handles `op://vault/item/field` references (or symbolic names), never resolved values. Values are resolved by `@1password/sdk` in the **tool-execution layer** at the moment of use and injected into the HTTP client / browser fill / subprocess env — never placed in prompts, tool arguments, responses, or logs.

### D-CR3 — Per-tool reference whitelist

Because there is no per-item scoping in 1Password and the model could be hijacked, **each tool declares the exact `op://` references it may resolve.** The model cannot cause resolution of an arbitrary `op://` path. This is the most important guardrail (it substitutes for the missing per-item scoping) and links to `tool-access`.

### D-CR4 — Token hardening + rotation

The Service Account token lives in a root-owned `0600` file (e.g. systemd `EnvironmentFile`), never in the repo, never dumped to logs/context, and is on the hard blocklist (D-SEC4). It is rotated on a schedule (1Password has no auto-expiry), reusing `scheduling`.

### Rejected alternatives (credentials)

- **Point a token at Devon's existing/personal vault:** impossible (1Password blocks Service Accounts from the Private vault) and would defeat "Sunny can't read my creds." Use a dedicated vault.
- **Custom-built secrets vault:** unnecessary given 1Password's SDK + Service Accounts; reuse the user's existing trusted store.
- **1Password Connect / Business audit / capability-segmented multi-vault:** deferred. Connect only if rate limits bite; Business only if native audit is needed; multi-vault segmentation revisited when the credentialed-browser/email paths grow (start with one dedicated vault for simplicity).
- **Desktop-app MCP server / SSH agent:** require an interactive desktop session; unusable on a headless server.

## Risks / Trade-offs (credentials)

- **The token is a master key to the Sunny vault:** anything that reads the token, or tricks a tool into resolving an arbitrary reference, can read every item in that vault. Mitigated by: minimal vault contents, read-only, per-tool reference whitelist (D-CR3), token hardening (D-CR4), and the AUTO/APPROVAL gates.
- **Single vault = coarser blast radius than capability-segmented vaults:** accepted for simplicity now; the vault is kept minimal and segmentation is a documented future step.
- **Copy (not live-link) duplicates:** rotated creds must be updated in both places; noted as a curation chore.
- **No native audit without Business:** mitigated by Sunny's own audit log (D-SEC7).

---

# Tool Access

## Context (tool-access)

Sunny's value is in its tools: shell on the host, a web-research fetcher, a credentialed browser, email, todos, and building/hosting websites (via the `devbox` skill). Each tool has a different risk profile and different credential needs; the security and credentials policies must attach to tools uniformly.

## Goals / Non-Goals (tool-access)

**Goals:**
- A uniform way to register tools that carries risk tier + credential references.
- Every tool's gating derives from its declared risk tier via the security policy.
- The credentialed browser tool routes through the isolated profile (D-SEC5) and resolves logins via reference whitelist (D-CR3).

**Non-Goals:**
- Enumerating the final, complete tool set now (it grows); this defines the *contract* every tool follows.

## Decisions (tool-access)

### D-TA1 — Bash-centric capability; permissioning at the command/skill layer (revised per review)

*(This supersedes an earlier framing that proposed a dedicated gated tool per permissioned activity — see Review Resolutions R13. Devon's point: in a CLI-centric world bash is the universal tool, and per-activity tools are brittle. Researched prior art — Claude Code's permission rules + hooks, `allowed-tools`, Hermes/OpenClaw/Goose/OpenHands — strongly supports gating at the **command** level.)*

Capability is exposed primarily through a **`bash` tool** (most third-party capabilities are CLIs) plus a few genuinely non-CLI tools (the credentialed browser driver, memory ops). Permissioning therefore attaches to **commands and skills**, not to a proliferation of per-activity tools. The layered model:

```
 (a) Command-approval policy  deny-by-default allow/ask/deny rules, matched on a
                              PARSED command (AST), enumerating every sub-command
                              across pipes/$()/chains, FAIL-CLOSED on substitution/
                              complexity (uncertain → ask). Patterns route; they are
                              NOT a security boundary (Claude Code says so explicitly).
 (b) Skill-scoped allowlists  an active skill pre-approves only the commands it needs
                              (`allowed-tools`-style); grants within the deny baseline.
                              → this is "permissioning in the skills layer."
 (c) Smart-mode triage        a cheap model (Haiku) triages only the uncertain "ask"
                              middle (D-SEC3 / R10) — never the sole gate.
 (d) Hard blocklist           non-overridable, trips first (D-SEC4).
 (e) Containment boundary     the REAL security layer: sandbox (bubblewrap/Landlock/
                              seccomp) + egress control. "Contain at the environment
                              layer first, steer at the model layer second."
 (f) Per-command credentials  `op run`: the model emits `op://` refs; they resolve into
                              ONLY that subprocess's env at exec time (masked in output),
                              never the model context (refines D-CR2/D-CR3).
```

### D-TA2 — Tools, skills, and where permissioning lives

```
  TOOLS (thin)              Notes
  ─────────────────────────────────────────────────────────────
  bash                      the universal capability surface; gated per-command (D-TA1)
  credentialed browser      genuine non-CLI tool (Playwright); isolated profile (D-SEC5)
  memory read/write         core-memory mutation (serialized, R7)

  CAPABILITIES AS SKILLS    (compose bash + the tools above)
  ─────────────────────────────────────────────────────────────
  build / run / host sites  → the `devbox` skill (over bash); public deploy is an
                              ask/blocked command in the policy
  email read / triage       → a skill over bash + the himalaya CLI (R5); the himalaya
                              *send* subcommand is hard-gated by the command policy
  research, todos, etc.     → skills composing bash / web fetch
```

Permissioning is uniform: every command — whether typed directly or run by a skill — passes the command-approval policy (a) + blocklist (d), within the skill's declared scope (b), with the uncertain middle triaged by smart-mode (c), contained by the sandbox/egress boundary (e), and credentials injected per-command (f). "Acting as the owner" commands (himalaya send, credentialed browser actions, publish/deploy) are hard-gated regardless of smart-mode.

**Containment via taint-tracking + step-up auth, not blanket sandboxing (resolved with Devon, R14).** Blanket-sandboxing bash is self-defeating — Sunny needs real host access to do devops on its own server. The risk isn't "untrusted commands" in the abstract; it's a command whose *construction was influenced by untrusted content* (a prompt injection from a web page / email / installed-skill output). So we **track provenance** and gate on it:

- **Clean commands** — derived from Devon's direct instruction with no untrusted content in the run's context — run under the normal command policy (allow/ask/deny) with **full host access**. This is the devops path; sandboxing would break it, so we don't.
- **Tainted commands** — produced while untrusted content is in context — require **step-up ("2FA") approval**: a distinct, high-friction confirmation that shows the exact command *and flags its untrusted provenance*, ideally backed by a real second factor (TOTP / passkey / out-of-band tap) so it can't be quietly rubber-stamped. Credentialed/destructive tainted commands get the strongest confirmation or are refused.
- **Unattended (scheduled/autonomous) runs** can't step-up an absent human, so a tainted command there is **blocked and deferred to Devon**, or run in a *targeted* sandbox for that case only. (Sandboxing isn't gone — it's the fallback when no human is present, not the everyday boundary.)
- **Egress/network control stays a cheap backstop** regardless — it limits where data can flow even if a tainted command runs, and it isn't intrusive to devops (it's network policy, not command sandboxing).

This honors "direct host access" for the common path while putting the strongest gate exactly where the injection risk concentrates.

### D-TA3 — Credentialed browser specifics

The browser tool runs in the isolated profile (D-SEC5), fills credentials resolved from its whitelisted references at fill-time inside the automation layer (never echoed to the model, D-CR2), and any credentialed *action* is approval-gated. 1Password's enterprise "Secure Agentic Autofill" is not used (early-access/enterprise); this is the DIY equivalent.

### Rejected alternatives (tool-access)

- **Ad-hoc per-tool security handling:** rejected; gating and credential rules must be uniform and declarative so a new tool can't accidentally bypass them.
- **Giving tools broad credential access:** rejected; default is no credential references, opt-in per reference (D-TA1/D-CR3).

## Risks / Trade-offs (tool-access)

- **Tool authors could under-declare risk:** a tool mis-tiered as `auto` could bypass approval. Mitigated by conservative defaults (unknown/destructive → approval) and review of new tools.
- **Reading email/web is `auto` but feeds untrusted content into the model (D-SEC6):** the consequence-gating (D-SEC3/4) is what keeps this safe, not the read itself.
- **Catalog will grow:** the contract (D-TA1) is the durable part; specific tools are added over time.

---

