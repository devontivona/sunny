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

## Build principle: prefer AI SDK primitives, don't hand-roll

Sunny is built on the Vercel AI SDK. Before building any of the machinery in this
change from scratch, evaluate what the AI SDK already provides and use it: **tools**
(`tool()` definitions, typed args/results), **MCP** (MCP client/transport for external
tool servers), **agents/loops** (multi-step tool-calling, stop conditions), **skills**,
and **sandboxes** (Vercel Sandbox for isolated execution). The registration contract
(D-TA0), tool surface, and any skill/sandbox plumbing should wrap AI SDK primitives
rather than reimplement them. Hand-roll only where the AI SDK genuinely has no
equivalent, and note why.

**Evaluation (verified against `ai@6.0.206`, the installed version):**

| Need | AI SDK provides? | Decision |
|---|---|---|
| Tool definitions | `tool()` (core export from `ai`) | **Wrap** — every tool is a `tool()`; the D-TA0 contract (risk tier, `op://` refs) is metadata layered on top |
| Agents / multi-step loop | `Agent` / `ToolLoopAgent` (core) | **Wrap** — use the ToolLoopAgent pattern for the turn loop (confirm/migrate the current loop in `src/agent/`) |
| MCP client | `experimental_createMCPClient` + stdio/SSE transports | **Wrap** — use for external MCP tool servers when needed |
| bash / file tools | the `bash-tool` npm pkg (`bash`/`readFile`/`writeFile`, supports `@vercel/sandbox`) | **Evaluate** for the thin tools (tasks 8) instead of hand-rolling |
| Skills / progressive disclosure | **No loader API**, but the SDK officially adopts agentskills.io + `npx skills add` and ships a cookbook integration guide | **Hand-roll the loader** (no API exists) following the cookbook pattern; the format is agentskills.io (D-SK1) — feed matched skill bodies into the Agent's system prompt and expose skill scripts via `tool()` |
| Sandbox | **External**: `@vercel/sandbox` (full VM isolation) | Use `@vercel/sandbox` for the `security-permissions` targeted-sandbox fallback; not a core primitive |

So skills are the one place we genuinely build the runtime ourselves (no SDK equivalent) — but on AI SDK primitives (`tool()`, the Agent) and the open format, not a bespoke stack.

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
  `references/`, `assets/`. The store of record is a dedicated git repo (D-SK8); the
  local `~/.sunny/skills/` is the working copy.
- **D-SK2 — Progressive-disclosure loading on a shared always-on budget.** Only
  `name` + `description` are always in context; the body loads on match; `references/`
  /`scripts/` on demand (script code never enters context, only output). The metadata
  index is budget-capped (drop least-used descriptions first, retain names) and shares
  the always-on budget from `agent-memory`.
- **D-SK3 — Discovery scales via pgvector retrieval** when the library outgrows the
  metadata budget — reusing the memory L3 local-embeddings + `pgvector` path. No new datastore.
- **D-SK4 — Self-authoring loop (auto + notify).** A `skill_manage` tool lets Sunny
  create/edit/delete its own skills: reflect on a completed task → write a pushy,
  keyword-rich `SKILL.md` → validate → commit to the skill repo (D-SK8) → auto-discovered
  next run. Created automatically, user notified, immediately usable, reviewable/reversible
  via the repo's git history.
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
- **D-SK8 — Unified personal skill repo.** Skills persist in a dedicated git repo Sunny
  can commit to (e.g. `devontivona/skills`). This unifies the two paths into one
  workflow: a **self-authored** skill is committed to the repo and then installed like
  any other via `npx skills add devontivona/skills/<name>`; **found** external skills are
  installed via `npx skills add owner/repo` and may be vendored into the same repo. So
  `npx skills` is the single install path for both, and the repo's git history is the
  durable, reviewable, portable record (`~/.sunny/skills/` is just the synced working
  copy). NB: Sunny committing/pushing requires git auth — a credential reference (D-CR3),
  and `git push` is gated by the command policy in `security-permissions`.

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
- **D-TA2 — Bash-centric capability; capabilities compose as skills.** The thin-tool
  surface is deliberately minimal: `bash` (universal), `file-read`, and **memory ops**
  (the one genuinely non-CLI tool — DB mutation). Everything else is a CLI driven via
  bash or a `SKILL.md` skill over bash: **browse** (the `agent-browser` CLI, D-TA3),
  **email** (himalaya), **website-builder** (devbox), **web fetch** (a fetch CLI such as
  `curl`/a markdown-extractor, or the browse capability for rendered pages), research/todos.
  So even browsing and fetching are CLIs-over-bash, exactly like email — **not** dedicated
  tools. Command-level *permissioning* of all of these (D-TA1) is in `security-permissions`.
- **D-TA3 — Credentialed browse capability (engine: Vercel `agent-browser`, default).**
  `agent-browser` (the native CDP CLI) is the default engine. Rationale (verified from
  primary sources): it is **token-efficient by design** (compact ref-based a11y page
  representation, which compounds over multi-step browsing); it has **durable on-disk
  sessions** decoupled from the daemon (`--session-name` → `~/.agent-browser/sessions/`,
  auto-loaded on start; `--profile <path>` for full state; optional **AES-256-GCM** at
  rest) so the owner logs in once and the session survives restarts; it ships a built-in
  encrypted **auth vault** so "the LLM never sees passwords" out of the box; and being a
  **CLI** it fits Sunny's bash-centric design (D-TA2) rather than fighting it: Sunny
  drives it through the **bash tool** (gated per-command in `security-permissions`),
  exactly like himalaya for email — there is no dedicated browser tool. The owner's
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
- **D-CR2 — The model handles names/references, never values.** Tools and skills refer to
  a credential by a **symbolic name** (e.g. `gmail`); the reasoning model never handles a
  secret value. At point of use the tool layer resolves name → `op://` reference → value
  via `@1password/sdk` and injects it into the HTTP client / browser fill / subprocess env
  — never in prompts, tool args, responses, or logs. (References are pointers, not secrets,
  so they may appear in context; operating on symbolic names keeps skills portable.)
- **D-CR3 — The vault is the authorization boundary; provisioning *is* the grant.** Because
  the Service Account is **read-only**, Sunny can never add to the vault — so the vault's
  contents are exactly the credentials Devon has decided Sunny may use, and only Devon can
  change that set. **Adding an item to the `Sunny` vault is the authorization**; there is no
  load-bearing code-level per-tool whitelist, and "who owns the name→reference mapping"
  stops mattering for grants — Sunny may freely know/store references (pointers) because
  knowing where a credential is grants nothing it couldn't already reach. *Misuse* of an
  in-vault credential (right cred at the wrong target, or exfiltration) is contained by
  **consequence-gated approval on credentialed *actions*** (D-SEC3) + **egress control**,
  not by sub-vault scoping (which 1Password lacks). *(Optional later: a per-tool/skill scope
  limiting which named credentials a tool may touch — a lateral-movement control for when
  the vault holds many high-value items, populated by the provisioning flow (D-CR5), not
  hardcoded; `scopeResolver` is the mechanism, now a secondary control rather than the
  boundary.)*
- **D-CR5 — The name→reference mapping lives in a Sunny credential registry, not SKILL.md.**
  The mapping from symbolic name → `op://` reference is stored in a dedicated structured
  **credential registry** (`~/.sunny/credentials.json`) inside the `~/.sunny` git repo —
  reviewable, reversible, owner-editable like memory and skills. It holds **references +
  metadata (name, purpose, added-by, added-at), never values.** SKILL.md is deliberately
  not extended for this: it is the portable agentskills.io *procedure* format, and embedding
  personal vault paths would break skill portability and conflate concerns. A skill at most
  invokes a capability ("use the email client"); it never carries a vault reference.
  The registry is populated by a **request-and-tell flow**: when Sunny needs a credential it
  lacks, it asks Devon over iMessage ("I need your Gmail password to set up the email client
  — add it to the Sunny vault and tell me the reference"); Devon adds the item in 1Password
  and replies with the reference; Sunny records `name → reference` and **test-resolves it to
  verify** it points at a real value (without surfacing the value). Recording entries is
  safe because the registry holds only pointers into a vault Devon controls; Devon can
  audit/edit the file anytime.

> **D-CR4 (token hardening + rotation)** lives in `security-permissions`: the token file
> on the hard blocklist, scheduled rotation via `scheduling`. This change only needs the
> token to exist and not be committed.

## Risks / Trade-offs

- **Ungated capability window:** mitigated by attended-testing-only posture (no
  autonomous runs) until `security-permissions` lands.
- **The token is a master key to the Sunny vault:** mitigated by a minimal, read-only,
  Devon-curated vault (the authorization boundary, D-CR3); full hardening/rotation in
  `security-permissions`.
- **A hijacked Sunny can *misuse* an in-vault credential without reading it** (route it at
  a bad target / exfiltrate via an env var): this — not disclosure to the model — is the
  real credential risk, and it is contained by consequence-gated approval on credentialed
  *actions* (D-SEC3) + egress, plus keeping the vault minimal. Lateral movement within the
  vault is the residual; the optional per-tool scope (D-CR3) addresses it if it grows.
- **Single vault = coarse blast radius:** accepted for simplicity; the vault is kept
  minimal and per-capability segmentation is documented as future.
