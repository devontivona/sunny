## Context

Sunny's runtime home `~/.sunny` accreted across several branches. Today `~/.sunny` is *itself* a git repo that tracks `config.json` + `memory/*.md` and gitignores `skills/`. Three subsystems persist state inconsistently:

- **memory** (`applyMemoryWrite`, `src/memory/index.ts`) — `writeFileSync` through a serialized chain, **never commits** after the one-time seed.
- **credentials** (`registerCredential`, `src/credentials/index.ts`) — `writeFileSync`, **never commits**; `credentials.json` is untracked-and-unignored despite a comment claiming it is tracked.
- **skills** (`commitSkillChange`, `src/skills/index.ts`) — the only one that works, because `skills/authored` is its own clone (of `devontivona/skills`) with a remote, committed and pushed on write.

The reason skills works and the others don't is structural: `authored/` is a real git repo *nested inside* the `~/.sunny` repo. That nesting is the embedded-repo antipattern and is the sole reason `skills/` is gitignored. Separately, `devontivona/skills` packages skills at the repo root, which is not the `npx skills`-installable layout, and a bundled `skill.mjs` duplicates (and has drifted from) the TS skill-persistence logic.

Constraints carried from the project: secrets never leave 1Password (only `op://` references are stored); the cached system prefix must stay byte-stable; all git operations remain best-effort/non-fatal.

## Goals / Non-Goals

**Goals:**
- Make state persistence actually deliver history/backup, consistently, across memory and credentials.
- Eliminate repo-nesting so no `.gitignore`-of-siblings is needed.
- Make `devontivona/skills` installable by other agents (spec layout).
- One source of truth for skill git logic; accurate layout documentation.
- A safe, in-place migration for the existing host.

**Non-Goals:**
- Changing the SKILL.md format, authoring semantics, or trust model (owned by the in-flight `agent-skills` change).
- Changing the credential-reference / 1Password resolution model (owned by `security-tools-credentials`).
- Moving `media/` into version control (it stays untracked binary data).
- Backing up the `installed/` third-party tier (re-installable; out of scope here).

## Decisions

**D1 — `~/.sunny` becomes a namespace dir; `state/` and `skills/` are siblings.**
Rather than gitignoring children out of a top-level repo, each concern is an independent sibling with its own backing. This is the change that removes the jank: no git repo is nested inside another's tracked tree, so the embedded-repo problem and the `.gitignore` both disappear. *Alternative considered:* keep `~/.sunny` as the repo and gitignore `skills/`/`media/` precisely — rejected because it preserves nesting and still cannot back up `authored/` (a nested repo can only be tracked as a gitlink/submodule, i.e. a pointer, not files).

**D2 — `config.json` stays at `~/.sunny/config.json` as local, unsynced bootstrap.**
There is a bootstrap chicken-and-egg: the `state` remote is named in config, but config cannot live inside the repo we need its value to clone. Keeping `config.json` local mirrors how `config.skills.repo` already bootstraps the skills clone. *Alternative:* put `config.json` in `state/` and supply the remote via an env var (`SUNNY_STATE_REPO`) — rejected as splitting config knowledge across two places for marginal backup benefit; config is small and regenerable.

**D3 — Introduce `stateDir = join(runtimeDir, 'state')`; repoint state path helpers at it.**
`credentialsPath`, `memoryPaths`, and the `sites/` path resolve under `stateDir`; `config.json`, `skills/`, and `media/` stay under `runtimeDir`. This is a contained change localized to path-resolution functions.

**D4 — Single `commitState(config, message)` helper; commit-on-write, push-on-cadence.**
Mirrors `commitSkillChange`. Called from `applyMemoryWrite` and `registerCredential` after each serialized write. Commit is synchronous and cheap; push is best-effort and debounced onto the existing ~10-minute skill-sync tick to avoid a push per keystroke-level write. *Alternative:* push synchronously per write — rejected as chatty and latency-coupling state writes to network.

**D5 — Restructure `devontivona/skills` to `skills/<name>/`; authored write-root → `authored/skills`.**
The spec/`npx` multi-skill convention is a top-level `skills/` container. Cloning a nested-layout repo inherently yields `authored/skills/<name>/` — the double level is intrinsic to `git clone` (no native prefix-strip; symlink/sparse-checkout hacks were rejected for fragility against the trust-by-location model). The loader already auto-detects nested layout for reading; only the *write* root (`skillsPaths().root`) needs to move to `authored/skills`.

**D6 — Drop the root-level multi-skill loader path; keep single-skill + nested.**
The `<name>/SKILL.md`-at-root detection existed only to tolerate the malformed repo. Removing it makes the loader implement the spec rather than a workaround. Sequenced strictly after D5 so `authored/` keeps loading through the transition.

**D7 — Regenerate `skill.mjs` from the corrected three-root seed-asset.**
One source of truth (`src/skills/seed-assets/skill.mjs`), including the `sync` command and the `authored/skills` target, ends the TS-vs-mjs drift and the live re-seed bug where the flat helper wrote outside the loader root.

**D8 — Relax the `agent-memory` no-egress requirement to permit an owner-private backup remote.**
The baseline spec forbade transmitting memory to any third-party service. An owner-controlled private git remote is not third-party processing, so the requirement is amended to forbid only LLM/analytics/managed-memory egress while permitting the private backup. This is the one spec-level behavior change and is called out as BREAKING in the proposal.

## Risks / Trade-offs

- **Personal memory + `op://` refs now leave the host** → Mitigated by a *private* owner-controlled remote; no secret values leave 1Password; no service processes the contents. Surfaced explicitly to the owner.
- **Migration data loss** → Mitigated by operating on copies/`git mv` (never `rm` originals until verified), and by making the migration idempotent and guarded (only acts when `~/.sunny/.git` exists at the top level).
- **Transition window where the loader can't find authored skills** → Mitigated by strict sequencing: ship D5 (repo restructure + write-root move) before D6 (drop root-level layout); verify `authored/` loads at each step.
- **`skill.mjs` already pushed to the public repo in its flawed flat form re-seeds hosts** → Mitigated by D7 regenerating it and pushing the corrected version before other hosts sync.
- **Push cadence hides failures** → Mitigated by logging push outcomes and keeping commits local on failure so no data is lost; a later "diverged" notice path can reuse the skill-sync pattern.

## Migration Plan

1. Land the code changes (stateDir, commitState, skills write-root, loader, helper, prompt) on `split-agent-tooling-security`.
2. Create the private `devontivona/sunny-state` repo; restructure + push `devontivona/skills` to `skills/<name>/`.
3. On the host: stop the service; verify `~/.sunny/.git` is the top-level repo; create `~/.sunny/state/`; `git mv`/move tracked `memory/` (+ `topics/`), `credentials.json`, and `sites/` into `state/`; relocate `.git` to back `state/`; set the `sunny-state` remote; initial commit + push.
4. Re-point `skills/authored` at the restructured repo (fetch + ff, or re-clone) so it lands as `authored/skills/<name>/`.
5. Restart; confirm: `~/.sunny` has no top-level `.git`; state writes commit; a memory edit appears in `state` history; authored skills load and a new authored skill round-trips to `devontivona/skills`.
6. **Rollback:** the original `.git` is preserved until step 5 verification passes; on failure, move it back to `~/.sunny` and revert the code.

## Open Questions

- Final repo name `devontivona/sunny-state` (assumed; rename if desired).
- Whether to also un-ignore/track `installed/skills-lock.json` for reproducible third-party reinstall (currently a non-goal; can be a follow-up).
- Whether the migration should be a one-shot script vs. documented manual steps given there is effectively one host.
