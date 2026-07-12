# Runtime home: split scratch / data / state by write authority

## Why

`~/.sunny/state/` currently serves two masters: it is the deterministic code's commit-on-write record (memory, credentials, schedules, mcp.json) *and* the only durable place the agent can put its own artifacts (sites, ad-hoc ledgers like `task-assistant/history.json`). Because `commitState` runs `git add -A`, agent-dropped files get silently swept into unrelated commits with misleading messages ("memory: replace INDEX.md"), the spec's clean-tree invariant is violated in practice (the live tree is dirty right now), and prompt guidance alone has already failed twice (a prior "remove scratch litter" cleanup commit, and the task-assistant skill inventing its own directory). Separately, the website-builder skill still writes to the pre-migration `~/.sunny/sites/` path, and nothing commits site writes at all.

## What Changes

- Partition the runtime home into three write-authority domains:
  - `~/.sunny/scratch/` — temporary, machine-local, garbage-collected (existing dir gains a real GC policy).
  - `~/.sunny/data/` — **new**: agent-authored durable artifacts (sites, project ledgers, structured working state). Its own git repository with a private remote; persisted by a periodic sweep commit + best-effort push (no git discipline required of the agent).
  - `~/.sunny/state/` — code-managed only. The agent-facing `file-write`/`file-edit` tools refuse paths under it, so `git add -A` in `commitState` becomes safe and commit messages truthful.
- Move sites from `state/sites/` to `data/sites/` (`sitesDir()` repointed; migration relocates content and any other non-reserved entries out of the state repo).
- **BREAKING** (internal layout): `state/sites/` no longer exists; the state repo tracks only the reserved set (`memory/`, `credentials.json`, `schedules/`, `mcp.json`).
- Teach the scratch/data/state convention in the **interactive** system prompt, not only the durable-job prompt (today interactive turns hold bash + file tools with zero placement guidance).
- Runtime warns when the state repo working tree is dirty (untracked/modified files it didn't write), instead of silently absorbing them.
- Content fixes that fall out: website-builder skill's stale `~/.sunny/sites/` path → `data/sites/`; coding skill's "scratch projects live under `state/projects/`" → `data/projects/` (and stop calling durable projects "scratch").

## Capabilities

### New Capabilities

_None — this restructures existing runtime-home and tool-access behavior._

### Modified Capabilities

- `runtime-home`: state-repo scope narrows to the reserved code-written set; new `data/` repository requirement (layout, sweep persistence, remote, migration); scratch requirement gains GC and interactive-prompt teaching; dirty-state-tree warning.
- `tool-access`: `file-write`/`file-edit` gain a path guard refusing writes under `~/.sunny/state/`, with a recoverable error that names `data/` and `scratch/` as the correct homes.

## Impact

- Code: `src/config/index.ts` (`sitesDir`, new `dataDir`), `src/runtime.ts` (boot mkdir, GC, sweep/push tick, dirty-tree check), `src/state/index.ts` (data-repo helpers or generalization), `src/agent/prompt.ts` (interactive + job prompt sections), `src/agent/tools/` file-tool path guard, migration module.
- Config: `~/.sunny/config.json` gains a `data` remote entry (optional; unset ⇒ local-only repo, push no-op).
- Live state: one-time migration on Devon's host — relocate `state/sites/` and stray entries (`task-assistant/`, root litter) into `data/`, commit the removal in the state repo.
- Authored skills (live, outside this repo): website-builder and coding skill wording — tracked as ops tasks, not code tasks.
- Docs: runtime-home spec, tool-access spec, prompt text, memory of the convention.
