## Why

`~/.sunny` is itself a git repo that tracks `config.json` + `memory/*.md` and gitignores `skills/`, but the design it promises is not delivered: memory and credential writes never commit (only a one-time seed commit exists), so the working tree is permanently dirty and there is no history or backup. The `skills/authored` clone is a git repo nested *inside* the `~/.sunny` repo (the embedded-repo antipattern), which is the only reason `skills/` must be gitignored. Meanwhile `devontivona/skills` packages its skills at the repo root instead of the spec/`npx`-installable `skills/<name>/SKILL.md` layout, so other agents cannot cleanly install from it — defeating the repo's stated purpose. Three subsystems persist state three different ways, and one (skill authoring) ships a duplicated, drifted git helper that writes to the wrong location.

## What Changes

- **`~/.sunny` stops being a git repo** and becomes a plain namespace directory. `config.json` stays at `~/.sunny/config.json` as a **local, unsynced bootstrap** that names the state and skills remotes (mirroring how `config.skills.repo` already bootstraps the skills clone).
- **New `~/.sunny/state/` git repo** synced to a new **private** remote (`devontivona/sunny-state`), tracking `memory/` (core + `topics/`), `credentials.json` (`op://` references only, never secret values), and `sites/`. A new `commitState()` helper commits on every state write and pushes best-effort on the existing ~10-minute sync cadence (not per-write).
- **`~/.sunny/skills/` becomes a sibling of `state/`** rather than a nested child: `authored/` (clone of `devontivona/skills`), `trusted/<slug>/` (read-only owned clones), `installed/` (npx quarantine). Because the clones are no longer nested inside a tracked tree, the embedded-repo problem disappears and **no `.gitignore`-of-siblings is needed**. `~/.sunny/media/` likewise remains an untracked sibling.
- **`devontivona/skills` is restructured to the spec layout** `skills/<name>/SKILL.md` so other agents can `npx skills add devontivona/skills`. Consequence: the authored tier's write root (`skillsPaths().root`) moves to `authored/skills`; the loader already auto-detects the nested layout for reading.
- **Loader simplification:** drop the non-spec root-level multi-skill layout detection (`<name>/SKILL.md` at repo root) that existed only to tolerate the malformed repo. Keep single-skill (`SKILL.md` at root) and nested (`skills/<name>/`) layouts. The `installed/` recursive loader is unaffected.
- **Unify skill git logic:** regenerate the bundled `skill-authoring/scripts/skill.mjs` from the corrected three-root seed-asset (single source of truth, includes `sync`, targets `authored/skills`); fix `agent/prompt.ts` and the stale `skill-sources/` comment to describe the real `authored`/`trusted`/`installed` layout.
- **BREAKING (spec):** memory and credential state are now pushed to a private offsite git remote. This relaxes the `agent-memory` capability's absolute "no third-party egress" requirement to permit an **owner-controlled private backup remote** (no LLM/analytics egress is introduced; no secret values leave 1Password).
- A one-time **migration** moves the existing tracked files into `state/`, relocates `.git`, sets the new remote, and pushes an initial commit.

## Capabilities

### New Capabilities
- `runtime-home`: The on-disk topology and persistence model of `~/.sunny` — namespace directory, local bootstrap config, the `state/` repo and its private-remote backup/sync via `commitState`, the sibling `skills/` tiers (authored/trusted/installed) and `media/`, the authored write-root and the supported skill layouts, the single-source skill git helper, and the migration from the old layout.

### Modified Capabilities
- `agent-memory`: Memory now lives under `~/.sunny/state/memory/`, is committed on every write, and may be pushed to an **owner-controlled private** backup remote. The "files-first / no third-party egress" requirement is amended to forbid only third-party *LLM/analytics* egress while permitting an owner-private git backup.

## Impact

- **Code** (branch `split-agent-tooling-security`): `src/config/index.ts` (bootstrap + `stateDir`), `src/memory/index.ts` (paths under `state/`, drop the old root-repo init, add `commitState`), `src/credentials/index.ts` (path under `state/`, commit on write, fix the tracked-file comment), `src/skills/index.ts` (write-root → `authored/skills`, drop root-level layout, fix `skill-sources` comment), `src/skills/seeds.ts` + `src/skills/seed-assets/skill.mjs` (single-source helper), `src/agent/prompt.ts` (accurate layout).
- **Repos:** restructure + push `devontivona/skills` (public); create `devontivona/sunny-state` (private).
- **Runtime:** one-time on-disk migration of an existing `~/.sunny`.
- **Cross-change overlap:** refines the in-flight `skills` (agent-skills) and `security-tools-credentials` (credentials) changes — those govern the SKILL.md/authoring/trust and credential-reference semantics, which are unchanged here; this change governs only where those artifacts live and how they persist.
- **Privacy:** personal memory and `op://` references are pushed to a private GitHub repo (offsite but owner-controlled); secret values remain in 1Password.
