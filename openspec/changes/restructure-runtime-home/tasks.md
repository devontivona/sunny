## 1. Config & state path foundations

- [x] 1.1 Add a `stateDir` resolver (`join(runtimeDir, 'state')`) in `src/config/index.ts`; keep `config.json` resolving at `runtimeDir` (local bootstrap).
- [x] 1.2 Add `config.state.repo` to the config schema + default seed (alongside `config.skills.repo`); document it as the private `state` remote.
- [x] 1.3 Repoint `credentialsPath` (`src/credentials/index.ts`) and `memoryPaths` (`src/memory/index.ts`) to resolve under `stateDir`; add a `sitesDir` under `stateDir`.

## 2. State repository + commit-on-write

- [x] 2.1 Add a `commitState(config, message)` helper (new module or in `memory/`): `git add -A` → `git commit` in `stateDir`, best-effort/non-fatal, mirroring `commitSkillChange`.
- [x] 2.2 Replace the old `ensureGitRepo` (top-level `~/.sunny` seed, `memory/index.ts:204`) with a `state`-repo initializer: clone `config.state.repo` on a fresh empty host, else `git init` in `stateDir` + `git remote add` + initial commit; handle divergence best-effort (warn, no auto-merge).
- [x] 2.3 Call `commitState` from `applyMemoryWrite` (after the serialized write) and from `registerCredential`, with descriptive messages.
- [x] 2.4 Add a debounced/periodic best-effort `git push` for `stateDir`, piggybacking the existing ~10-min skill-sync tick; failures non-fatal, commits remain local.
- [x] 2.5 Fix the comment at `credentials/index.ts:139` to reflect that `credentials.json` lives in the `state` repo.

## 3. Skills layout & loader

- [x] 3.1 Move the authored write root: `skillsPaths().root` (`src/skills/index.ts:61`) resolves to `<authored>/skills`; verify `writeSkill`/`deleteSkill`/seed target it and `commitSkillChange` still runs in the clone root.
- [x] 3.2 Restructure the `devontivona/skills` repo contents under a top-level `skills/<name>/` directory; commit and push.
- [ ] 3.3 Re-point/refresh the local `authored/` clone against the restructured repo so it materializes as `authored/skills/<name>/`; confirm all authored skills load.
- [x] 3.4 Remove the root-level multi-skill layout detection from the loader; keep single-skill (root `SKILL.md`) and nested (`skills/<name>/`). (Strictly after 3.2/3.3.)
- [x] 3.5 Confirm the `installed/` recursive loader (`loadInstalledSkills`) and `trusted/<slug>` sync are unaffected by 3.1–3.4.

## 4. Unify skill git logic & documentation

- [x] 4.1 Correct `src/skills/seed-assets/skill.mjs` to the three-root layout targeting `authored/skills`, including the `sync` command (single source of truth).
- [x] 4.2 Regenerate/replace the bundled `skill-authoring/scripts/skill.mjs` from the corrected seed-asset; re-seed so hosts get the fixed helper.
- [x] 4.3 Fix `src/agent/prompt.ts` skills section to describe the real `authored`/`trusted`/`installed` layout (remove flat `~/.sunny/skills/<name>` and `~/.sunny/skill-sources/`).
- [x] 4.4 Fix the stale `skill-sources/` doc comment at `skills/index.ts:457` to `skills/trusted/<slug>`.

## 5. `.gitignore` hygiene

- [x] 5.1 Ensure the `state` repo carries no `.gitignore`-of-siblings (it lives beside `skills/` and `media/`, not above them); remove the legacy top-level `skills/` ignore as part of migration.
- [x] 5.2 Delete the stray `~/.sunny/test-image.jpg` during migration; confirm `media/` remains untracked data (its own `*` ignore is fine).

## 6. Migration

- [x] 6.1 Write the migration procedure (guarded: only act when `~/.sunny/.git` is the top-level repo): create `state/`, `git mv`/move `memory/` (+ `topics/`), `credentials.json`, `sites/` into it; relocate `.git` to back `state/`; preserve the original `.git` until verification.
- [x] 6.2 Create the private `devontivona/sunny-state` repo; set it as `stateDir`'s remote; initial commit + push.
- [ ] 6.3 Verify post-migration invariants: `~/.sunny` has no top-level `.git`; `state` tree clean; a memory edit lands in `state` history; authored skill round-trips to `devontivona/skills`.

## 7. Tests & verification

- [x] 7.1 Unit-test `commitState` (commit happens; push failure is non-fatal; commit persists).
- [x] 7.2 Update/add memory + credentials tests for the `stateDir` paths and commit-on-write behavior.
- [x] 7.3 Test the loader: nested and single-skill layouts load; root-level `<name>/SKILL.md` does not; `installed/` recursive load unchanged.
- [x] 7.4 Update any tests/fixtures that assumed `~/.sunny/memory` or `~/.sunny/credentials.json` at the old paths.

## 8. Memory note & follow-ups

- [x] 8.1 Update the project memory note that tracked the deferred three-root migration ("task 16") to reflect completion.
- [x] 8.2 Capture the open questions (final remote name; optional `installed/skills-lock.json` tracking) as follow-ups if not resolved during apply.
