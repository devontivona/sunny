# Sunny — Security Model

> **Status:** this documents the *designed* security model for Sunny (a self-hosted
> personal AI agent). It is forward-looking — it describes what the implementation
> must enforce, not a finished system. The authoritative requirements live in
> [`openspec/changes/bootstrap-sunny/specs/`](openspec/changes/bootstrap-sunny/specs/)
> (notably `security-permissions`, `tool-access`, `credentials`, `agent-skills`);
> the rationale and decision IDs (D-SEC*, D-TA*, D-CR*, D-SK*, R1/R9/R10/R13/R14)
> live in [`design.md`](openspec/changes/bootstrap-sunny/design.md).

Sunny acts on its owner's behalf with real power: shell on a home server, a browser
driving logged-in sessions, email, and the ability to install and run skills — while
constantly reading **untrusted content** (web pages, emails, installed skills) that
can carry injected instructions. This document explains how we contain that.

---

## Core principle

**Assume the model can be hijacked by untrusted content.** Prompt injection is not
reliably solvable, so we do **not** try to keep the model's *reasoning* pure. Instead
we ensure that a hijacked Sunny still cannot take an irreversible or secret-leaking
action without a hard rule or a human step stopping it.

> We gate **consequences**, not thoughts. (D-SEC1)

Everything below follows from this.

---

## What we're protecting, and from what

**Assets:** the owner's 1Password secrets, logged-in web sessions, email, the host
and its files, money, and the owner's reputation (Sunny can act *as* them).

**Untrusted inputs (injection vectors):** web pages Sunny browses, emails it reads,
skills it installs, and file/tool output it ingests. Any of these can carry
instructions that try to hijack the agent.

**The governing risk — the "lethal trifecta":** Sunny simultaneously holds *private
data* + *untrusted input* + *an exfiltration path*. No permission model makes that
fully safe unattended; the design cuts the risk rather than eliminating it.

---

## The gauntlet: how every command is gated

Capability is exposed primarily through **bash** (most third-party tools are CLIs),
so permissioning lives at the **command** level — not in a proliferation of bespoke
tools. Every command (typed by the owner or emitted by a skill) runs the same
deny-by-default gauntlet:

```
 command
   │
 1 IDENTITY        Only the owner (paired identity) can trigger consequential actions
   │               or grant approvals. In group chats, non-owners can be answered but
   │               not obeyed for consequential actions. (R1, D-SEC2)
   │
 2 HARD BLOCKLIST  Catastrophic actions refused ALWAYS — even with an approval:
   │               disk wipes, fork bombs, reading the 1Password token or the browser
   │               cookie store, weakening Sunny's own guardrails. (D-SEC4)
   │
 3 COMMAND POLICY  Deny-by-default allow / ask / deny, matched on a PARSED command
   │               (AST) — every sub-command across pipes, $(...) and chaining is
   │               checked, and classification FAILS CLOSED (anything unparseable,
   │               substitution-bearing, or uncertain → ask, never allow). (D-TA1)
   │
 4 SKILL SCOPE     An active skill pre-approves only the commands it declares
   │               (allowed-tools-style). Grants WITHIN the deny baseline; never
   │               removes gating for commands outside its scope. (D-TA1, D-SK6)
   │
 5 TAINT GATE      Was this command's construction influenced by UNTRUSTED content
   │               (web page / email / installed-skill output)?  (R14)
   │                 • CLEAN  (owner-directed, no untrusted content in context)
   │                          → run with full host access. This is the devops path.
   │                 • TAINTED→ STEP-UP "2FA": a high-friction, provenance-flagged
   │                          confirmation backed by a real second factor
   │                          (TOTP / passkey / out-of-band tap) so it cannot be
   │                          quietly rubber-stamped. Credentialed/destructive
   │                          tainted commands get the strongest confirmation or are
   │                          refused.
   │                 • TAINTED + UNATTENDED (scheduled run, no human) → blocked and
   │                          deferred to the owner, or confined to a targeted sandbox.
   │
 6 SMART TRIAGE    A cheap fast model (Haiku-class) triages ONLY the uncertain "ask"
   │               middle to reduce friction — never the sole gate, and the
   │               hard-gated categories bypass it. (D-SEC3, R10)
   │
 7 CREDENTIALS     The model emits op:// REFERENCES, never secret values. `op run`
   │               resolves a reference into ONLY that subprocess's environment at
   │               execution time (masked in output). A command can resolve only the
   │               references explicitly whitelisted for it / its skill. (D-CR2/3, D-TA1)
   │
 8 EGRESS BACKSTOP Network egress is restricted regardless — it limits exfiltration
   │               even if a bad command runs, and (being network policy, not command
   │               sandboxing) it doesn't impede devops.
   │
 9 AUDIT + BUDGET  Every command and secret access is logged (secrets redacted). A
                   global daily/monthly spend ceiling + an agent-loop step cap bound
                   runaway. (D-SEC7, R8, observability)
```

**Approvals** (step 5) are **durable-suspended** (survive restarts at no idle cost),
**id-correlated** (a reply maps to the specific pending request), **owner-only**, and
**default-deny on timeout**. (R9)

The credentialed **browser** is a genuine non-CLI tool: it runs in an **isolated,
persistent logged-in profile**; its cookie/session store is treated as a credential
surface (on the blocklist, never read by other tools); credentialed actions are
hard-gated. (D-SEC5, R6)

---

## Skills

Skills are where capability becomes *comprehensive* — but they receive **no extra
privilege**:

- **Two trust tiers.** *Self-authored* skills (Sunny wrote them under its own
  guardrails) are created auto-and-notify. *Installed* skills (`npx skills add …`,
  from any Git source) are **untrusted code**: installation is approval-gated,
  validated, and reviewed before enable. (D-SK4/5/7)
- **No privilege escalation.** A skill's commands run the *same* gauntlet above.
  `allowed-tools` can only **narrow** a skill, never widen it — so a malicious
  installed skill can do nothing its commands wouldn't already be allowed to do. (D-SK6)
- **Skills are a taint source.** Installed-skill output is untrusted content, so
  commands derived from it are tainted (step 5).

---

## Credentials

- Backed by **1Password** via a read-only **Service Account scoped to a dedicated,
  minimal `Sunny` vault** — Service Accounts cannot reach the owner's Private vault,
  so everything outside the Sunny vault is unreadable *by construction*. (D-CR1)
- **The model never sees secret values** — only `op://` references. Values resolve in
  the tool/command layer (`op run`) and are injected into a single subprocess's env,
  never into prompts, tool arguments, responses, or logs. (D-CR2)
- **Per-tool / per-skill reference whitelist:** a command can resolve only the
  references it (or its skill) is permitted to — the model cannot request an arbitrary
  `op://` path. This substitutes for 1Password's lack of per-item scoping. (D-CR3)
- The token lives in a hardened, root-owned `0600` file, is rotated on a schedule, and
  is on the hard blocklist. (D-CR4)

---

## Why this protects you — and stays flexible

Two design choices give us security *and* usability:

1. **Taint-tracking is the flexibility win (R14).** The naïve "safe" design —
   sandbox everything — would cripple Sunny's reason to exist (devops on its own
   host). Instead, **clean** work (anything you directly asked for, no untrusted
   content in the loop) runs with **full host access and no friction**. You pay the
   security tax (step-up 2FA) only on the genuinely dangerous path: commands shaped by
   content an attacker might control. Most use is clean, so Sunny is mostly unimpeded.

2. **Secrets are structurally out of the model's reach.** Because the LLM only ever
   sees references and `op run` binds values to a single subprocess, a *fully
   compromised model cannot read or exfiltrate a secret directly* — only request its
   scoped *use*. The dedicated vault caps the blast radius to what Sunny needs.

The protection is **defense-in-depth**: no single layer is "the boundary." A hijacked
model still hits identity, blocklist, the command policy, the taint gate, and
credential scoping; if one layer is fooled, the next narrows the blast radius, and
egress control is the last-ditch limiter on exfiltration.

---

## Residual attack vectors (known and accepted)

Listed roughly highest-risk first. These are real; the design reduces but does not
eliminate them.

1. **Social-engineering the approver.** A hijacked model can craft an
   *innocuous-looking* approval request; a tired human who rubber-stamps it lets it
   through. Step-up 2FA + provenance flagging reduce this — **the human-in-the-loop is
   load-bearing, and a fatigued human is the weakest link.** *(Biggest residual.)*
2. **Taint-tracking gaps.** The clean/tainted split is only as good as provenance
   tracking. Injected content reaching the model through an unmarked path — or taint
   "laundering" through memory — could put a dangerous command on the clean (full
   access) path.
3. **"Allowed binary, arbitrary effect."** AST allow-listing limits *which* commands
   run, not *what they do*: `go test`, `make`, `find -exec`, `git -c core.sshCommand=…`
   turn an allowed command into arbitrary execution. Egress control is the backstop —
   so loose egress turns this into exfiltration.
4. **Token / cookie / host compromise bypasses the agent.** Anything that reads the
   Service Account token reads the whole Sunny vault; the persistent browser cookie
   store is a live-session surface. A host-level compromise that isn't *via* the agent
   (a bad dependency, an SSH foothold) sidesteps every gate here.
5. **Supply chain.** The Vercel SDKs, Photon adapter, himalaya, `@1password/sdk`, and
   every npm dependency run in-process with the token; a compromised dependency is not
   visible to these gates.
6. **Memory / self-skill poisoning (slow burn).** Memory writes are low-friction;
   injected content could plant false facts or push Sunny to author a subtly malicious
   self-skill that later executes cleanly. Git history of `~/.sunny/` lets you catch it
   — if you look.
7. **Group-chat influence.** Non-owners can't *trigger* actions, but their messages
   enter context and can *influence* Sunny's reasoning when it later acts for the
   owner. Owner-tagging gates triggering, not influence.
8. **Smart-mode is itself injectable.** The Haiku triage on the uncertain middle can
   be talked into "safe." That's why it is never the sole gate — but it is a soft spot.
9. **Unattended runs.** A scheduled job reading untrusted email is the highest-risk
   moment (no human to step up). Tainted commands block/defer there, but that depends
   entirely on taint-tracking (#2). Spend/step caps bound *runaway*, not a single
   targeted malicious action.
10. **Approval-channel trust.** Approvals ride iMessage via Photon/Spectrum Cloud; a
    compromised transport or a spoofed number could forge an approval. The 2FA second
    factor is the mitigation for tainted commands.

---

## Highest-leverage hardening (future)

If/when we want to harden beyond the v1 model:

- **Tighter egress control** — the single biggest lever; kills most exfiltration even
  on a bad/misclassified command.
- **Make step-up genuinely out-of-band** — so an approval can't be social-engineered
  through the same chat channel an attacker may control.
- **Sandbox installed-skill execution** (not just gate installs) and consider
  sandbox-by-default for unattended runs.
- **Reduce standing privilege** — narrower vault(s) per capability, shorter-lived
  tokens, per-action credential scoping.
- **Native audit** — 1Password Business access logs (the self-hosted audit log does
  not depend on it, but native logs add a second record).

---

*This model is intentionally honest about its limits. Sunny holds the lethal trifecta;
the goal is to make the dangerous paths loud, gated, and contained — not to claim they
are impossible.*
