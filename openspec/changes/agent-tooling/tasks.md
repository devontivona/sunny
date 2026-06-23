> Build plan for the **agent-tooling** change — the capability layer (skills, tools,
> 1Password resolution plumbing). The *enforcement* layer (approval, command policy,
> taint/step-up, blocklist, token hardening/rotation, audit gating) is the companion
> **security-permissions** change, which reads the declarations recorded here. D-*
> decisions are in this change's `design.md`. Ungated state is attended-testing-only.

## Foundations
- [x] 0 Prefer AI SDK primitives — evaluated against `ai@6.0.206` (see design "Build principle" table): `tool()` for tools, `Agent`/`ToolLoopAgent` for the loop, `experimental_createMCPClient` for MCP, the `bash-tool` pkg for bash/file, `@vercel/sandbox` (external) for sandboxing. Skills loader is the one hand-rolled piece (no SDK API) — built on `tool()` + the Agent + the agentskills.io format.

## Skills runtime (agent-skills)
- [x] 1 `SKILL.md` loader (agentskills.io format) reading `~/.sunny/skills/<name>/SKILL.md`; progressive disclosure — always-on, budget-capped, byte-stable index (`renderSkillIndex`) in the system prompt; body loaded on demand (`loadSkillBody` via `skill_manage view`). `src/skills/index.ts`, wired in `prompt.ts`/`loop.ts`/`runtime.ts` (D-SK1/2). *(Unit-tested.)*
- [x] 2 Self-authoring `skill_manage` tool (list/view/create/edit/delete), owner-DM-gated, validate-before-write (D-SK7), serialized writer, auto+notify (tool prompts Sunny to tell the owner), local git commit (D-SK8). `src/agent/tools/skillManage.ts` (D-SK4/7/8). *(Unit-tested.)*
- [~] 3 Canonical skill repo (D-SK8): **done** — `config.skills.repo` (`devontivona/skills`, private) is the store of record; `~/.sunny/skills` is a **clone** synced on init (`syncSkillRepo`: clone on fresh host, ff-pull otherwise) and committed + **pushed** on every edit via the host's git auth (gh credential helper) — no `op://` for git; bundled seeds are the cold-start fallback; trust-tier marking. **Deferred**: the `npx skills` external-install path + lockfile (`skills-lock.json`) for found skills (not vendored), and seeding skill-creator/find-skills (D-SK1/5/8).
- [ ] 4 (Deferred by design) `pgvector` retrieval over skill descriptions when the metadata budget is exceeded — not needed at current library size; reuses memory L3 infra when it lands (D-SK3).

## Credential plumbing (credentials)
- [x] 5 `@1password/sdk` resolver in the tool layer (`src/credentials/index.ts`): `OnePasswordResolver` resolves `op://vault/item/field` refs, values never returned to the model or logged (D-CR2); `resolverFromEnv` reads `OP_SERVICE_ACCOUNT_TOKEN`, wired into runtime → loop deps. *(Manual setup for Devon — create the dedicated read-only `Sunny` vault + Service Account; documented in `.env.example`. Token hardening + rotation: security-permissions.)* *(Unit-tested.)*
- [x] 6 The vault is the authorization boundary (D-CR3): read-only SA → Sunny can't expand what it may use. Per-tool whitelist (`scopeResolver`) **dropped from the MVP** (too heavy; the vault boundary + action-gating suffice).
- [x] 6a Credential registry (`~/.sunny/credentials.json`, in the repo, owner-reviewable): symbolic name → `op://` reference + metadata, **never values** (`loadRegistry`/`registerCredential`/`listCredentials`); `resolveByName` (registry → resolver → value in the tool layer); tools/skills refer to credentials by name (D-CR2/D-CR5). `src/credentials/index.ts`. *(Unit-tested.)*
- [x] 6b Request-a-credential capability: `credential_manage` tool (owner-DM) — `list` credentials, `discover` op:// references from the vault (titles only, no values), `register` a name→reference and **test-resolve to verify** it points at a real value without surfacing it; the tool/prompt direct Sunny to ask the owner (via send_message) for a missing credential rather than invent a reference (D-CR5). `src/agent/tools/credentialManage.ts`. *(Unit-tested.)*

## Tool contract + thin tools (tool-access)
- [x] 7 ~~Uniform tool-registration contract~~ — **superseded** (D-TA0 revised after implementation): there is no per-tool security contract. Gating attaches at the **command** (bash AST policy), **action** (approval tiers), and **credential-name** (registry) layers — all already present — not a per-tool risk-tier/`op://` declaration. The only residual (a read-only tool catalog) folds into task 15.
- [x] 8 Thin host tools (`src/agent/tools/bash.ts`): `bash` (real host shell via `child_process`, timeout + output caps + exit code) and `file_read` (capped); owner-DM only, never in autonomous runs (separate memory-only toolset). Hand-rolled (see build-principle table — `bash-tool` is interpreter/sandbox-oriented). Web fetch = bash (`curl`)/the browse capability, not a dedicated tool (D-TA2). *(Unit-tested.)*
- [x] 9 Per-command credential injection (`execBash`, D-TA5): the `bash` tool takes `credentials` (ENV var → credential name), resolves each via the registry into that subprocess's env, and **masks the values out of the output**; never in model context. Also strips Sunny's own secrets (OP token, API keys, …) from every bash env. *(Unit-tested.)*

## Dashboard (web-dashboard delta) — built first so the picture comes together
- [ ] 11 Read-only **Tools directory** (registered tools: name + purpose + owner-only flag) + the **credential registry** (names → `op://` refs + purpose, **no values**), and **Skills directory** (each skill: description, trust tier, source); observe-only, per `DESIGN.md`. **Data-driven** from the live tool list / credential registry / skill loader, so capabilities added by later tasks surface automatically; built first so the capability surface is visible as it grows.

## Capabilities as skills
- [x] 10 **Email** skill (over `himalaya`): bundled seed → now in the canonical skill repo (`devontivona/skills`); read/search/triage/send via bash with `HIMALAYA_PASSWORD` injected per-command; bodies untrusted; send self-confirmed with the owner (D-TA2). **Live:** himalaya configured for the Gmail mailbox (`folder.aliases` for sent/drafts/trash, `save-copy = false`), app password in the Sunny vault + registered, read/send working. Runbook: `docs/email-setup.md`. *(himalaya `send` hard-gated later: security-permissions.)*
- [ ] 12 **Website-builder** skill: single-page HTML for explainers/presentations/reports; bundles a small library of design styles in the skill's `assets/` (accept a style or recommend one); uses the `devbox` skill to build/run/host (D-TA2).
  - [ ] 12a Dashboard: confirm the website-builder skill appears in the **Skills directory** (task 11).

## Credentialed browse capability
- [ ] 13 Browse engine: Vercel `agent-browser` (default) with a **durable on-disk session** (`--session-name` → `~/.agent-browser/sessions/`, optional AES-256-GCM; credentialed mode, login once, survives restarts) + an **ephemeral context** (research mode); owner session state stays on the host. Playwright `launchPersistentContext` (+ optional Stagehand `env:"LOCAL"`) kept as the fallback for deterministic scripted flows (D-TA3).
  - [ ] 13a Dashboard: confirm browse site-logins appear in the **credential registry** (task 11); browse runs via bash, so it adds no new Tools-directory entry.
- [ ] 14 1Password seeds the session: resolve the declared `op://` ref in the automation layer and seed agent-browser's session / encrypted auth vault once; value never reaches the model; 1Password stays source-of-truth (D-TA3 / D-CR1/2). *(Credentialed-action approval gate: security-permissions.)*
- [ ] 15 Per-site browse skills as engine-agnostic `SKILL.md` via the standard loader: consume the **browse.sh catalog** (`browse skills add <id>` as a fetcher, or fetch the raw `.md` — no hard `browse`-runtime dependency) and Sunny-**self-authored** site skills; execute over agent-browser verbs. Do **not** adopt the `browse`/Stagehand-CLI-bound `browserbase/skills` capability skills (D-TA4).
  - [ ] 15a Dashboard: confirm per-site browse skills appear in the **Skills directory** (task 11).

## Verify
- [ ] 16 Exercise the capability paths under **attended** operation: bash, web-fetch, email read+send, a credentialed browser login persisting across runs, website-builder output served via devbox, and a self-authored skill round-trip — and confirm each surfaces in the dashboard directories (task 11). No autonomous/scheduled runs of credentialed/destructive paths until security-permissions lands.
