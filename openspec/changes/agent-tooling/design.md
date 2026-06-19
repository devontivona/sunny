# Design — Agent Tooling (skills · tools · credential plumbing)

> The capability layer: skills, tools, and the 1Password resolution plumbing that lets
> them authenticate. The *enforcement* half (approval tiers, command-permissioning,
> taint/step-up, blocklist, credential hardening/rotation, audit gating) lives in the
> companion **security-permissions** change, which reads the declarations recorded here.

## Sequencing principle: capability first, enforcement as a layer

We build and test the tools and skills **before** the gating layer. The move that
keeps this from becoming a rewrite: **every tool declares its risk tier and `op://`
references from day one (the contract, D-TA0), but nothing reads those declarations
to gate yet.** `security-permissions` later adds the engine that reads them — a wrapper
around the existing tool surface, with tool interfaces unchanged.

The ungated state is **attended-testing-only** — no autonomous/scheduled runs of
credentialed or destructive capabilities until `security-permissions` lands.

---

# Agent Skills

## Context

A central part of Sunny's vision is that it can **install, write, and learn its own
skills** — modular, file-based units of procedure. The `agentskills.io` `SKILL.md`
format is a real multi-vendor open standard (Claude Code, Cursor, Hermes, the Vercel
skills already in this repo), with progressive disclosure for context efficiency and
shipping prior art for runtime self-authoring (Anthropic's skill-creator). Install
sources are just **Git + the format**: `npx skills add owner/repo` installs from any
Git source; `skills.sh` is a zero-curation discovery index over the same substrate.
Because installed skills are untrusted third-party code, they are gated at install
(enforcement in `security-permissions`).

## Decisions

- **D-SK1 — Adopt the `SKILL.md` open standard, files-first.** `skills/<name>/SKILL.md`
  (YAML frontmatter — `name`, `description` required; optional `license`,
  `compatibility`, `metadata.version`, `allowed-tools`) plus optional `scripts/`,
  `references/`, `assets/`, stored under `~/.sunny/skills/`, git-able like the memory soul.
- **D-SK2 — Progressive-disclosure loading on a shared always-on budget.** Only
  `name` + `description` are always in context; the body loads on match; `references/`
  /`scripts/` on demand (script code never enters context, only output). The metadata
  index is budget-capped (drop least-used descriptions first, retain names) and shares
  the always-on budget from `agent-memory`.
- **D-SK3 — Discovery scales via pgvector retrieval** when the library outgrows the
  metadata budget — reusing the memory L3 local-embeddings + `pgvector` path. No new datastore.
- **D-SK4 — Self-authoring loop (auto + notify).** A `skill_manage` tool lets Sunny
  create/edit/delete its own skills: reflect on a completed task → write a pushy,
  keyword-rich `SKILL.md` → validate → auto-discovered next run. Created automatically,
  user notified, immediately usable, reviewable/reversible via git.
- **D-SK5 — Two trust tiers: self-authored (trusted) vs installed (untrusted).**
  Self-authored → auto+notify. Installed (any agentskills-compatible Git source via
  `npx skills add`) → untrusted code; install is APPROVAL-gated and reviewed
  (*gating enforced in `security-permissions`*). Seed `anthropics/skills`,
  `vercel-labs/agent-skills`, and `devbox` as known-good defaults — including a
  **skill-authoring** skill and a **skill-discovery/installation** skill so Sunny can
  uplevel itself (the "skills that get more skills" flywheel).
- **D-SK6 — Skills cannot escalate privilege.** A skill body is instructions; its
  scripts/tools route through the normal tool surface so the same gating, approval
  tiers, and blocklist apply (enforced in `security-permissions`). `allowed-tools`
  may only *further restrict*.
- **D-SK7 — Validation before activation** against the `SKILL.md` schema; invalid → not activated.

---

# Tool Access (contract + concrete tools)

## Context

Sunny's value is its tools: shell on the host, web fetch, a credentialed browser,
email, and building/hosting sites (via `devbox`). Most third-party capability is a
CLI, so **bash is the universal surface** and capabilities compose as skills over it.
The security and credential policies must attach to tools uniformly — hence a single
registration contract every tool follows.

## Decisions

- **D-TA0 — Uniform tool-registration contract (declared here, enforced later).**
  Every tool is registered through one contract carrying its **risk tier**
  (auto/approval/forbidden) and its **`op://` reference whitelist** (default none).
  These declarations are recorded and surfaced (dashboard) in this change but not yet
  gated; `security-permissions` adds the engine that reads them. This is the seam that
  lets enforcement layer on without changing tool interfaces.
- **D-TA2 — Bash-centric capability; capabilities compose as skills.** Thin tools:
  `bash` (universal), `file-read`, `web-fetch`, plus the non-CLI browse capability and
  memory ops. Higher capabilities are `SKILL.md` skills over bash: **email** (himalaya),
  **website-builder** (devbox), research/todos. Command-level *permissioning* of these
  (D-TA1) is in `security-permissions`.
- **D-TA3 — Credentialed browse capability (engine: Vercel `agent-browser`, default).**
  `agent-browser` (the native CDP CLI) is the default engine. Rationale (verified from
  primary sources): it is **token-efficient by design** (compact ref-based a11y page
  representation, which compounds over multi-step browsing); it has **durable on-disk
  sessions** decoupled from the daemon (`--session-name` → `~/.agent-browser/sessions/`,
  auto-loaded on start; `--profile <path>` for full state; optional **AES-256-GCM** at
  rest) so the owner logs in once and the session survives restarts; it ships a built-in
  encrypted **auth vault** so "the LLM never sees passwords" out of the box; and being a
  **CLI** it fits Sunny's bash-centric design (D-TA2) rather than fighting it. The owner's
  session state stays on the local host. Two modes: a **credentialed** persistent profile
  (login once, reused) and an **ephemeral research** context. 1Password remains the
  source of truth (D-CR1): Sunny resolves the `op://` reference and seeds the session /
  auth vault with it once; the value is injected in the automation layer and never
  reaches the model. **Fallback:** Playwright `launchPersistentContext` (+ optional
  Stagehand `env:"LOCAL"` AI layer) for deterministic, scripted flows where the in-process
  API and auto-wait assertions matter. Browserbase *cloud* is an optional escalation for
  **un-credentialed research only** (never for owner sessions). Approval-gating of
  credentialed *actions* is in `security-permissions`.
- **D-TA4 — Per-site browsing knowledge is engine-agnostic SKILL.md.** Per-site
  knowledge comes from two sources, both `agentskills.io` `SKILL.md` loaded through
  Sunny's existing loader (no second skill system) and executed over the active engine's
  verbs: (a) the **browse.sh curated catalog** (500+ per-site skills, `browse skills add
  <id>`) — verified **engine-agnostic** ("what to accomplish," not Stagehand/Playwright
  calls; some entries even declare a `recommended_method: api` HTTP path), consumed either
  by using `browse skills add` purely as a *fetcher* or by fetching the raw `.md` directly
  (**no hard `browse`-runtime dependency**); and (b) Sunny's own **self-authored**
  per-site skills (`skill_manage`). NB: this is distinct from the `github.com/browserbase/
  skills` *capability* skills (`browser`, `autobrowse`, …), which ARE `browse`/Stagehand-CLI
  bound — those are **not** adopted; only the engine-agnostic per-site catalog is.
- **D-TA5 — Per-command credential injection (`op run`).** The model emits `op://`
  refs; they resolve into only that subprocess's env at exec time (masked in output),
  never the model context. Refines D-CR2/D-CR3 at the command layer.

## Rejected / deferred (tool-access)

- **Browserbase cloud Contexts for credentialed sessions:** rejected — owner session
  state would live on third-party infra (the one thing to avoid). Cloud is research-only escalation.
- **Playwright/Stagehand as the default engine:** not chosen as default (kept as the
  fallback per D-TA3). agent-browser won on token efficiency, durable on-disk sessions, a
  built-in encrypted auth vault, and CLI-fits-bash-centric. Playwright stays the choice
  for deterministic scripted flows that want the in-process API + auto-wait assertions.
- **The `github.com/browserbase/skills` capability skills (browse/Stagehand-CLI bound):**
  not adopted; the engine-agnostic browse.sh per-site catalog (D-TA4) is used instead.
- **A dedicated gated tool per activity:** rejected for bash-centric + capabilities-as-skills.

---

# Credentials (resolution plumbing)

## Context

Devon stores secrets in 1Password. The official TS SDK (`@1password/sdk`) authenticates
with a **Service Account** token and resolves `op://` references in-process. Service
Accounts **cannot** access the Private/default Shared vaults (a safety feature → a
dedicated vault is required), there is **no per-item scoping** (the vault is the
blast-radius boundary), and the token is a master key to its scoped vault.

## Decisions

- **D-CR1 — Dedicated minimal `Sunny` vault + read-only Service Account.** A dedicated
  vault holds only what Sunny needs; a `read_items` Service Account scoped to just that
  vault provides access via `OP_SERVICE_ACCOUNT_TOKEN`. Everything else is unreadable by
  construction. Devon curates via the 1Password UI (Copy, not Move).
- **D-CR2 — The model sees references, never values.** The reasoning model only handles
  `op://vault/item/field` references; values are resolved by `@1password/sdk` in the
  **tool-execution layer** at point of use and injected into the HTTP client / browser
  fill / subprocess env — never in prompts, tool args, responses, or logs.
- **D-CR3 — Per-tool reference whitelist.** Because there is no per-item scoping and the
  model could be hijacked, **each tool declares the exact `op://` references it may
  resolve** (this is the credential half of the D-TA0 contract). The model cannot cause
  resolution of an arbitrary path. This substitutes for the missing per-item scoping.

> **D-CR4 (token hardening + rotation)** lives in `security-permissions`: the token file
> on the hard blocklist, scheduled rotation via `scheduling`. This change only needs the
> token to exist and not be committed.

## Risks / Trade-offs

- **Ungated capability window:** mitigated by attended-testing-only posture (no
  autonomous runs) until `security-permissions` lands.
- **The token is a master key to the Sunny vault:** mitigated by a minimal read-only
  vault and the per-tool whitelist now; full hardening/rotation in `security-permissions`.
- **Single vault = coarse blast radius:** accepted for simplicity; segmentation documented as future.
