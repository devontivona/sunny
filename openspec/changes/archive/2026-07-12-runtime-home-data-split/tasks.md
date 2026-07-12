# Tasks: runtime-home-data-split

## 1. Data repository foundation

- [x] 1.1 Add `dataDir()` to `src/config/index.ts` (sibling of `state/`), repoint `sitesDir()` to `~/.sunny/data/sites`, and add the optional data remote to the `config.json` schema/defaults
- [x] 1.2 Generalize the state git helpers in `src/state/index.ts` (`initStateRepo`/`commitState`/`pushState`) to take a repo dir, and add data-repo equivalents: init-if-absent (remote from config when named), `sweepData` (`git add -A` + commit `data: sweep`, no-op when clean), best-effort push
- [x] 1.3 Wire boot in `src/runtime.ts`: create/init the data repo, run a boot sweep, and add the periodic sweep+push onto the existing `pushState` tick
- [x] 1.4 Unit tests: data repo init idempotence, sweep commits dirty files / no-ops on clean tree, push no-op without remote

## 2. State-repo write authority

- [x] 2.1 Add the path guard to `file_write`/`file_edit` in the agent tools: refuse targets resolving inside `~/.sunny/state/` (symlink/`..`-safe via real path of deepest existing ancestor) with the recoverable error naming `data/` and `scratch/`; `file_read` untouched
- [x] 2.2 Add dirty-tree surfacing: `commitState` logs a warning naming stray paths found before its `git add -A`; boot logs the same when the state tree starts dirty (still commit — never drop data)
- [x] 2.3 Unit tests: guard blocks direct/symlinked/`..` paths into `state/`, allows `data/`, `scratch/`, and reads; dirty-tree warning fires and content is still committed

## 3. Scratch garbage collection

- [x] 3.1 Implement scratch GC in `src/runtime.ts`: delete top-level `~/.sunny/scratch/` entries older than the threshold (default 14 days, config-overridable; directory age = newest mtime within) at boot and on a daily tick
- [x] 3.2 Unit tests: old entries deleted, fresh entries and directories containing fresh files preserved, threshold override respected

## 4. Migration

- [x] 4.1 Implement the idempotent boot-time migration: init data repo, move every non-reserved top-level `state/` entry (not `memory/`, `credentials.json`, `schedules/`, `mcp.json`, git plumbing) into `data/`, commit removal in state (`migrate: relocate agent artifacts to ~/.sunny/data`) and arrival in data, push both best-effort
- [x] 4.2 Extend the migration to relocate a legacy `~/.sunny/sites/` directory (pre-runtime-home path the stale website-builder guidance kept populating — 5 live sites on Devon's host: craft-second-brain, decisions, dogs, espresso-compare, sunny-architecture) into `data/sites/`, merging with `state/sites/` content; on slug collision the copy with the newest content mtime wins the working tree, with the older copy committed to the data repo first so it stays in history
- [x] 4.3 Unit tests: `state/sites/` + legacy `~/.sunny/sites/` + ad-hoc dirs + stray root files relocate with content intact; on slug collision the newer copy is in the working tree and the older is reachable in data-repo history; reserved set untouched; second run is a no-op

## 5. Prompt and skill guidance

- [x] 5.1 Extract the placement guidance in `src/agent/prompt.ts` into a shared static three-domain section (scratch = temporary/may vanish; data = durable artifacts, sites → `data/sites`, projects → `data/projects`; state = code-managed, tools refuse it; facts → memory; procedures → skills) and include it in BOTH `buildSystemPrompt` (interactive) and `buildJobPrompt` host-tools block — static text only (prompt-cache safe)
- [x] 5.2 Update the builtin coding skill (`agent/builtin/skills/coding/SKILL.md`): projects live under `~/.sunny/data/projects/<name>/`, drop the word "scratch" for durable projects, point build logs at `~/.sunny/scratch/` instead of `/tmp`
- [x] 5.3 Sweep repo docs/comments for `state/sites` and the old convention (`src/config/index.ts` doc comments, `src/state/index.ts` header) and update to the three-domain model

## 6. Verification and deploy (ops — with Devon)

- [x] 6.1 Full local check: typecheck, unit tests, production vite build (build is NOT in CI — build locally before merging)
- [x] 6.2 Deploy at a Devon-approved restart window; confirm migration ran (state repo shows the relocation commit, `~/.sunny/data/` populated, boot warnings clean)
- [x] 6.3 Same window: re-point devbox serves for existing sites — both those moved from `~/.sunny/state/sites/*` and those from legacy `~/.sunny/sites/*` — to `~/.sunny/data/sites/*`
- [x] 6.4 Update ALL authored skills with stale paths (commit+push the authored repo once):
  - website-builder SKILL.md (~line 74): `~/.sunny/sites/<slug>/` → `~/.sunny/data/sites/<slug>/`
  - decision-coach SKILL.md (~lines 188, 191): `~/.sunny/sites/decisions/` → `~/.sunny/data/sites/decisions/`
  - task-assistant SKILL.md (~lines 106, 143): `~/.sunny/state/task-assistant/history.json` → `~/.sunny/data/task-assistant/history.json`
  - craft SKILL.md (~lines 267, 340): `~/.sunny/state/craft-resource-tagger.json` → `~/.sunny/data/craft-resource-tagger.json`
  - then re-grep the authored + trusted tiers for `~/.sunny/state` and `~/.sunny/sites` to confirm zero remaining references
- [x] 6.5 Create the private `sunny-data` remote and add it to `~/.sunny/config.json` (or explicitly defer — local-only is safe), then verify a sweep push lands
- [x] 6.6 Sweep runtime-home root litter with Devon (working files violating the namespace rule: `amazon_check.png`, `amz_search.png`, `download.html`, `hero.png`, `tmp/`) — move keepers into `data/` or `scratch/`, delete the rest
- [x] 6.7 Live smoke: ask Sunny to build a throwaway site and a task note — confirm site lands in `data/sites/`, a `file_write` aimed at `state/` is refused with the redirect error, and the next sweep commits the new files
