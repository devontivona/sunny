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
- [~] 3 Skill repo: **done** — trust-tier marking (authored vs installed), local commit to the `~/.sunny` repo, `config.skills.repo`. **Deferred** (blocked on credential plumbing, tasks 5/6 + security): dedicated *remote* `devontivona/skills` repo + `git push` via an `op://` ref, the `npx skills` unified install path, and seeding known-good defaults (skill-authoring, find-skills, devbox) (D-SK1/5/8).
- [ ] 4 (Deferred by design) `pgvector` retrieval over skill descriptions when the metadata budget is exceeded — not needed at current library size; reuses memory L3 infra when it lands (D-SK3).

## Credential plumbing (credentials)
- [ ] 5 1Password setup: dedicated read-only `Sunny` vault + Service Account; `OP_SERVICE_ACCOUNT_TOKEN` from an `EnvironmentFile` (not committed); `@1password/sdk` wrapper resolving `op://` refs **in the tool layer only**, never to the model (D-CR1/2). *(Token hardening + rotation: security-permissions.)*
- [ ] 6 Per-tool `op://` reference whitelist as part of the tool-registration contract; the model cannot resolve an arbitrary reference (D-CR3 / D-TA0).

## Tool contract + thin tools (tool-access)
- [ ] 7 Uniform tool-registration contract: every tool declares risk tier + `op://` references, recorded but **not yet enforced** (the seam security-permissions reads) (D-TA0).
- [ ] 8 Thin tools (minimal surface): `bash` (run host command, return output), `file-read`, memory ops. Web fetching is bash (a fetch CLI) or the browse capability — **not** a dedicated tool; any external content entering context is marked untrusted (D-TA2).
- [ ] 9 Per-command `op run` credential injection: `op://` → that subprocess's env at exec time, masked in output, never in model context (D-TA5).

## Capabilities as skills
- [ ] 10 **Email** skill over the `himalaya` CLI (read/triage/send for the Sunny mailbox); bodies treated as untrusted (D-TA2). *(himalaya `send` hard-gated: security-permissions.)*
- [ ] 11 **Website-builder** skill: single-page HTML for explainers/presentations/reports; bundles a small library of design styles in the skill's `assets/` (accept a style or recommend one); uses the `devbox` skill to build/run/host (D-TA2).

## Credentialed browse capability
- [ ] 12 Browse engine: Vercel `agent-browser` (default) with a **durable on-disk session** (`--session-name` → `~/.agent-browser/sessions/`, optional AES-256-GCM; credentialed mode, login once, survives restarts) + an **ephemeral context** (research mode); owner session state stays on the host. Playwright `launchPersistentContext` (+ optional Stagehand `env:"LOCAL"`) kept as the fallback for deterministic scripted flows (D-TA3).
- [ ] 13 1Password seeds the session: resolve the declared `op://` ref in the automation layer and seed agent-browser's session / encrypted auth vault once; value never reaches the model; 1Password stays source-of-truth (D-TA3 / D-CR1/2). *(Credentialed-action approval gate: security-permissions.)*
- [ ] 14 Per-site browse skills as engine-agnostic `SKILL.md` via the standard loader: consume the **browse.sh catalog** (`browse skills add <id>` as a fetcher, or fetch the raw `.md` — no hard `browse`-runtime dependency) and Sunny-**self-authored** site skills; execute over agent-browser verbs. Do **not** adopt the `browse`/Stagehand-CLI-bound `browserbase/skills` capability skills (D-TA4).

## Dashboard (web-dashboard delta)
- [ ] 15 Read-only **Tools directory** (each registered tool: risk tier + declared `op://` refs) and **Skills directory** (each skill: description, trust tier, source); observe-only, per `DESIGN.md`.

## Verify
- [ ] 16 Exercise the capability paths under **attended** operation: bash, web-fetch, email read+send, a credentialed browser login persisting across runs, website-builder output served via devbox, and a self-authored skill round-trip. No autonomous/scheduled runs of credentialed/destructive paths until security-permissions lands.
