# Design — Agent Tooling (skills · tools · credential plumbing)

> The capability layer: skills, tools, and the 1Password resolution plumbing that lets
> them authenticate. The *enforcement* half (approval tiers, command-permissioning,
> taint/step-up, blocklist, credential hardening/rotation, audit gating) lives in the
> companion **security-permissions** change, which reads the declarations recorded here.

## Sequencing principle: capability first, enforcement as a layer

We build and test the tools and skills **before** the gating layer. The capability
surface is what `security-permissions` later wraps: gating attaches to **commands** (the
bash AST policy), **actions** (approval tiers), and **credential names** (the registry) —
layers that already exist here — so adding enforcement is a wrapper around the existing
surface, not a rewrite, with tool interfaces unchanged. (We originally planned a per-tool
risk-tier + `op://` contract as that seam; implementation moved the seam to
commands/actions/credentials instead — see D-TA0.)

The ungated state is **attended-testing-only** — no autonomous/scheduled runs of
credentialed or destructive capabilities until `security-permissions` lands.

## Build principle: prefer AI SDK primitives, don't hand-roll

Sunny is built on the Vercel AI SDK. Before building any of the machinery in this
change from scratch, evaluate what the AI SDK already provides and use it: **tools**
(`tool()` definitions, typed args/results), **MCP** (MCP client/transport for external
tool servers), **agents/loops** (multi-step tool-calling, stop conditions), **skills**,
and **sandboxes** (Vercel Sandbox for isolated execution). The tool surface and any
skill/sandbox plumbing should wrap AI SDK primitives rather than reimplement them.
Hand-roll only where the AI SDK genuinely has no equivalent, and note why.

**Evaluation (verified against `ai@6.0.206`, the installed version):**

| Need | AI SDK provides? | Decision |
|---|---|---|
| Tool definitions | `tool()` (core export from `ai`) | **Wrap** — every tool is a `tool()` |
| Agents / multi-step loop | `Agent` / `ToolLoopAgent` (core) | **Wrap** — use the ToolLoopAgent pattern for the turn loop (confirm/migrate the current loop in `src/agent/`) |
| MCP client | `experimental_createMCPClient` + stdio/SSE transports | **Wrap** — use for external MCP tool servers when needed |
| bash / file tools | the `bash-tool` npm pkg (`bash`/`readFile`/`writeFile`, supports `@vercel/sandbox`) | **Hand-rolled** instead — `bash-tool` is built on `just-bash` (a JS bash *interpreter*) + `@vercel/sandbox`, oriented toward sandboxed/interpreted execution; Sunny needs **real host shell** for self-devops (D-TA2). A thin `child_process` tool fits better and keeps exact control (timeout, output caps, future op-run injection). Revisit `bash-tool`+`@vercel/sandbox` for the security-permissions *sandbox fallback*. |
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
- **D-SK4 — Self-authoring is a skill over bash + a `skill` helper, not a bespoke tool
  (revised after implementation).** The loop is unchanged — reflect on a completed task →
  write a pushy, keyword-rich `SKILL.md` (plus any `scripts/`/`references/`/`assets/`) →
  persist → auto-discovered next run, created automatically with the user notified and
  reviewable/reversible via git. What changed is the *mechanism*: rather than a bespoke
  `skill_manage` tool that only ever wrote a single `SKILL.md`, skill authoring is itself
  a bundled **skill** (D-SK5) executed over the existing `bash`/`file_read` surface — Sunny
  writes the skill's files directly (so a skill is a real *directory*, multi-file by nature)
  and runs a small **`skill` helper** (`new|save|rm`) — bundled *inside* the
  skill-authoring skill as `scripts/skill.mjs` (so it travels with the skill into the
  canonical repo; no global install) and invoked with `node` — that performs the
  load-bearing, get-it-right-every-time steps in one deterministic shot: **validate →
  stage → commit → push** (D-SK8). This is the bash-centric model (D-TA2) applied to
  Sunny's own toolmaking: the guarantees live in a deterministic CLI, not in model-driven
  multi-step git, and not in a growing tool surface. *(Rejected: extending `skill_manage`
  with per-file `write_file`/`delete_file`/`view --path` — it re-implements what bash+git
  already do, adds a hand-rolled path-traversal surface, and still special-cases the one
  capability that most wants to be a skill. The `skill` CLI takes a sanitized skill **name**,
  never a model-supplied path, so it adds no traversal surface.)*
- **D-SK5 — Two trust tiers: self-authored (trusted) vs installed (untrusted).**
  Self-authored → auto+notify. Installed (any agentskills-compatible Git source via
  `npx skills add`) → untrusted code; install is APPROVAL-gated and reviewed
  (*gating enforced in `security-permissions`*). Seed `anthropics/skills`,
  `vercel-labs/agent-skills`, and `devbox` as known-good defaults — including a
  **skill-authoring** skill and a **skill-discovery/installation** skill so Sunny can
  uplevel itself (the "skills that get more skills" flywheel). The **skill-authoring skill**
  is the concrete mechanism for D-SK4 (not a tool): a bundled seed whose body is the
  prescriptive procedure for writing a skill *directory* and persisting it via the `skill`
  helper command, which ships with the app. Because it is a seed, it self-heals (re-written
  if missing at init) even though Sunny could delete it — the durable *capability* is the
  helper CLI (in code), while the guidance is regenerable. **Bundled first-party seeds**
  (e.g. the `email` and `skill-authoring` skills, `src/skills/seeds.ts`) ship with the app
  and are written into `~/.sunny/skills` at init if absent — like the memory core, no manual
  deploy; external seeds come via `npx skills`.
- **D-SK6 — Skills cannot escalate privilege.** A skill body is instructions; its
  scripts/tools route through the normal tool surface so the same gating, approval
  tiers, and blocklist apply (enforced in `security-permissions`). `allowed-tools`
  may only *further restrict*.
- **D-SK7 — Validation before activation** against the `SKILL.md` schema; invalid → not activated.
- **D-SK8 — Canonical skill repo (self-authored + curated only).** Skills persist in a
  dedicated **private** git repo (`config.skills.repo`, e.g. `devontivona/skills`) that is
  the store of record; `~/.sunny/skills/` is a **clone** of it, synced on init (clone on a
  fresh host, fast-forward pull otherwise) and committed + pushed on every self-authored
  edit, so Sunny's improvements round-trip durably. The repo holds **self-authored** skills
  plus **curated first-party** defaults (e.g. `email`) — **not** found/installed external
  skills: those are installed from their own upstream repos and tracked by a lockfile
  (`skills-lock.json`), re-fetched from source, **not vendored** in (keeps the repo "your
  stuff", avoids staleness/license bloat). The **bundled seeds** (`src/skills/seeds.ts`)
  become a **fallback** for cold-start / when no repo is configured (write-if-missing after
  sync). **Git access is the host's own auth** (e.g. the gh credential helper / an SSH
  deploy key), set up when provisioning the box — **not** an `op://` ref; this removes the
  bootstrap chicken-and-egg (cloning a private repo no longer depends on the credential
  plumbing). Best-practice: scope that git credential to just the skills repo (deploy key /
  fine-grained PAT) for least privilege; `git push` is still gated by the command policy in
  `security-permissions`.

  The validate→stage→commit→push guarantees are delivered by the **`skill` helper** bundled
  inside the skill-authoring skill (`scripts/skill.mjs`, installed by `initSkills` and pushed
  with the skill — so any host has it with no global install), invoked from the skill body via
  `node` over the bash surface (D-SK4). Because it operates on the skill *directory*, these
  guarantees cover multi-file
  skills (`scripts/`/`references/`/`assets/`), not just `SKILL.md`. Validation (D-SK7) runs
  before commit, so a broken `SKILL.md` is never pushed; the loader also fail-safes invalid
  skills at read time (skipped + warned), so the two layers compose. Running over bash means
  the push is uniformly subject to the future command policy — unlike a tool calling
  `child_process` git directly, which would bypass it. Concurrency falls to git's
  `index.lock` (fails loud, never corrupts) plus per-thread turn serialization; a `flock` in
  the helper is the escalation if a single-user host ever contends.

  Keeping the clone fresh: `initSkills` syncs once at startup, and a background syncer
  (`startSkillSync`, every 10 min) pulls thereafter — **fast-forward only**, never an auto-merge.
  Because skill reads are live (the loader re-reads `~/.sunny/skills` each turn), a pull is
  picked up by the next turn with no restart. If local self-authored commits and the remote
  diverge, the sync reports `diverged`, leaves the working copy untouched, and Sunny tells the
  owner once (the owner reconciles). An on-demand `skill sync` (helper subcommand) does the
  same pull immediately when the owner knows the repo changed.

  **Multiple owned repos.** Beyond the single writable primary (`skills.repo` →
  `~/.sunny/skills`), the owner may list additional **owned** repos in `skills.repos`. Each is
  cloned **read-only** to `~/.sunny/skill-sources/<slug>` and ff-synced on the same cadence; the
  skill loader reads across all roots (primary first; on a name conflict the primary wins), so a
  capability you maintain in its own repo (e.g. `devontivona/devbox`) is available to Sunny and
  auto-updates on every push — no vendoring, no manual install, no `npx`. Self-authoring only
  ever writes the primary; sources are mirrors. Each source repo is auto-detected as a
  single-skill repo (`SKILL.md` at its root) or a collection (`<name>/SKILL.md` subdirs). This
  is the trusted, owner-curated lane; the untrusted third-party `npx skills add` lane (D-SK5,
  deferred) remains separate. Adding a repo later is one entry in `skills.repos`.

---

# Tool Access (contract + concrete tools)

## Context

Sunny's value is its tools: shell on the host, web fetch, a credentialed browser,
email, and building/hosting sites (via `devbox`). Most third-party capability is a
CLI, so **bash is the universal surface** and capabilities compose as skills over it.
The security and credential policies attach at the command / action / credential
layers (D-TA0), not per tool.

## Decisions

- **D-TA0 — No per-tool security contract; gating attaches to commands/actions/credentials
  (revised after implementation).** This change originally planned a uniform per-tool
  contract (each tool declaring a **risk tier** + an **`op://` reference whitelist**) as
  the seam `security-permissions` would read. Implementation made that obsolete:
  - Credentials moved to the **vault-as-boundary + name registry** (D-CR3/D-CR5), so there
    are no per-tool `op://` refs to declare — tools take a credential *name* at call time.
  - The **bash-centric** model means consequence is per-**command** (the AST command policy,
    D-TA1), per-**action** (approval tiers, D-SEC3), and per-**credential name** (the
    registry) — none of which is a per-tool declaration. The few non-bash tools
    (`send_message`, `memory_*`, `schedule_*`, `skill_manage`, `credential_manage`,
    `file_read`) are uniformly low-consequence and already owner-DM-gated.

  So **there is no per-tool security contract.** `security-permissions` reads the
  command / action / registry layers, which already exist here — adding enforcement is a
  wrapper around the existing surface, not a rewrite. The only residual is a **read-only
  tool catalog** (name + purpose + owner-gated) for the dashboard (task 15) — introspection,
  not enforcement, derivable from the registered tools.
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
  not by sub-vault scoping (which 1Password lacks). *(A per-tool/skill scope limiting which
  named credentials a tool may touch is intentionally **not in the MVP** — too heavy for the
  value at a minimal vault size; revisit as a lateral-movement control if the vault grows to
  hold many high-value items.)*
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
  audit/edit the file anytime. Sunny can also **discover** references itself (list the
  vault's item + field titles via the SDK, never values) so Devon needn't copy the
  `op://` path — the 1Password *mobile* app has no "Copy Secret Reference".

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
