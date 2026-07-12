# Design: scratch / data / state write-authority split

## Context

The runtime home already separates concerns structurally (`state/` repo, `skills/` tiers, `media/`, `scratch/`), but it partitions by *content type*, not by *who writes*. Everything durable the agent produces has exactly one sanctioned home only when it is a fact (memory), a procedure (skill), or one of the reserved code-written records. Anything else — sites, task ledgers, working JSON — ends up in `state/` by default, where `commitState`'s `git add -A` launders it into unrelated commits. Evidence in the live repo: `task-assistant/history.json` (agent-invented directory, currently dirty), `craft-resource-tagger.json` (untracked root litter), a prior `chore: remove scratch litter` commit, and a `sites/` tree whose only commit is the original migration.

Constraints:

- The agent gets file mutation only through `bash` and the `file-write`/`file-edit` tools (tool-access spec); the thin tools are ours to guard, bash is not.
- The always-on prompt prefix must stay byte-stable for Anthropic prompt caching — new guidance must be static text, not per-run content.
- The `portability` branch (unmerged) touches adjacent ground (state-repo mcp.json, doctor, deploy checklist). This change must not assume doctor exists; it should compose with it when it lands.
- Live deploy discipline: no devbox restart without Devon's say-so; migration runs at next restart.

## Goals / Non-Goals

**Goals:**

- Every path under `~/.sunny` has exactly one writer class: agent-temp (`scratch/`), agent-durable (`data/`), code (`state/`), or skill-sync machinery (`skills/`).
- The state repo's history becomes truthful: every commit is a code write with an accurate message; clean-tree invariant holds and violations are surfaced, not absorbed.
- Agent-durable artifacts get the same loss-protection as state: git history plus best-effort private-remote push.
- The convention is taught wherever the tools are held — interactive turns included — and enforced mechanically where we own the surface.

**Non-Goals:**

- No change to memory, skills tiers, credentials, or scheduling models.
- No hard sandboxing of `bash` (same-user process; filesystem ACLs against ourselves buy nothing). The path guard covers the tools the model reaches for first; bash misuse is detected (dirty-tree warning), not prevented.
- No per-write commit for `data/` — agent writes are bursty and mid-flight; sweep cadence is enough.
- Not migrating `media/` or rethinking its model.

## Decisions

### D1: `data/` is its own git repository, synced, swept periodically

Alternatives considered:

- *Subdirectory of the state repo with path-scoped commits* — keeps one remote, but re-mixes writer classes in one history, requires `commitState` to become path-aware, and the clean-tree invariant dies again (agent writes sit dirty between sweeps inside the code's repo).
- *Unsynced plain directory* — least machinery, but quietly reintroduces "important stuff that only exists on this machine," defeating the portability work.

Chosen: sibling repo at `~/.sunny/data/`, private remote named in `~/.sunny/config.json` (optional; absent ⇒ local-only repo and push is a no-op). Persistence is a **sweep**: on the existing periodic push tick (`runtime.ts` `onTick`, currently `pushState`), run `git add -A && git commit -m "data: sweep"` then best-effort push — reusing the state helpers generalized to take a repo dir. Also sweep once at boot so a crash never strands more than one interval of work. The agent never runs git here.

Half-written files at sweep time are acceptable: the next sweep commits the finished version, and history is an agent workspace, not an audit log.

### D2: Enforcement = tool refusal + prompt + dirty-tree detection

`file-write`/`file-edit` refuse any resolved path under `~/.sunny/state/` (symlink/`..`-safe: compare `realpath` of the deepest existing ancestor) with a recoverable error: *"~/.sunny/state is code-managed. Durable files → ~/.sunny/data/, temporary files → ~/.sunny/scratch/."* The model self-corrects off tool errors reliably; this converts the norm into an invariant on the surface it actually uses. `file-read` stays unrestricted.

Bash remains a loophole by design (Non-Goals). Backstop: `commitState` checks the tree *before* `git add -A`; if it finds changes outside the paths the caller just wrote — or a boot-time check finds a dirty tree — it logs a warning naming the stray files (and doctor can surface the same check when the portability branch lands). It still commits (never lose data), but the anomaly is loud instead of laundered.

### D3: Sites move to `data/sites/`

Sites are agent-authored durable artifacts — the definition of `data/`. `sitesDir()` repoints to `~/.sunny/data/sites`. This also finally gives site writes durability (the sweep), which they never actually had: nothing calls `commitState` for sites today. Devbox serves sites from absolute paths, so existing served sites need re-pointing — an ops task at migration time.

### D4: Migration by reserved-set rule

The state repo's reserved set is exactly `memory/`, `credentials.json`, `schedules/`, `mcp.json` (plus git plumbing). Migration (idempotent, runs at boot like the runtime-home migration before it):

1. Init `~/.sunny/data/` repo if absent (remote from config if named).
2. Move every non-reserved top-level entry of `state/` — tracked or not — into `data/` (`sites/`, `task-assistant/`, stray root files).
3. Also relocate the legacy `~/.sunny/sites/` directory into `data/sites/`: the website-builder skill's stale path kept populating it after the runtime-home migration, so five live sites (craft-second-brain, decisions, dogs, espresso-compare, sunny-architecture) currently sit outside any repo, unsynced. On slug collision, newest content mtime wins in the working tree; the older copy is committed to the data repo first so it survives in history (relevant because legacy `~/.sunny/sites/` was never git-tracked — dropping its copy outright would be unrecoverable).
4. Commit the removals in the state repo (`migrate: relocate agent artifacts to ~/.sunny/data`), commit the arrivals in the data repo, push both best-effort.

A deterministic rule beats an allowlist-of-known-litter: it also catches strays we haven't found.

### D5: Scratch gets real GC

Boot-time plus daily-tick deletion of top-level `scratch/` entries whose mtime (directories: newest mtime within) is older than 14 days (config-overridable). mtime-based aging protects in-flight work; 14 days is generous for "temporary." The prompt already says scratch is disposable; now it's true.

### D6: Teach the convention in both prompts

The `hostTools` placement block moves from job-prompt-only into a shared static section used by `buildSystemPrompt` (interactive) and `buildJobPrompt`, updated to the three-domain rule: scratch = temporary (may vanish), data = durable artifacts you author (sites → `data/sites`, projects → `data/projects`), state = never write (tools will refuse; code owns it), facts → memory, procedures → skills. Static text ⇒ cache-safe. Coding-skill and website-builder wording updates ride along (the latter lives in the authored skills repo — ops task).

## Risks / Trade-offs

- [Bash writes into `state/` still possible] → dirty-tree warning at commit/boot makes it visible within one write cycle; prompt says tools will refuse, which also deters the bash detour.
- [Second private remote to provision] → optional by config; local-only until Devon creates `sunny-data`. Doctor (portability branch) can nag once it exists.
- [Served sites break when `state/sites` moves] → migration is restart-time only; re-point devbox serves in the same ops window (deploy checklist item).
- [Sweep commits capture partial files] → accepted (D1); workspace history, not audit log.
- [GC deletes something wanted] → 14-day mtime threshold + the prompt telling the agent durable things belong in `data/`; scratch was always documented as disposable.
- [Authored skills carry stale paths and can't be fixed from this repo] → ops task covering all four (website-builder, decision-coach → `~/.sunny/sites/…`; task-assistant, craft → `~/.sunny/state/…`), plus a closing grep of the authored/trusted tiers. Until the skill fixes land, state-path writes are refused by the tool guard (the model self-corrects off the error), and legacy-sites-path writes land unsynced but harmless — the migration's legacy-sites step can be re-run to sweep them.

## Migration Plan

1. Merge + deploy (Devon-approved restart; composes with the pending watchdog-activity restart).
2. Boot runs: data-repo init → reserved-set relocation (D4) → scratch GC → normal startup. Idempotent; re-runs are no-ops.
3. Same ops window: re-point devbox site serves to `~/.sunny/data/sites/*`; fix website-builder SKILL.md path in the authored repo; create `sunny-data` remote and add it to `config.json` (or defer — local-only is safe).
4. Rollback: revert the code; files stay where migration put them (data repo remains valid; `sitesDir()` in old code would look at `state/sites` — so rollback includes `git mv` back, or just don't roll back past the migration without moving `sites/` back manually). Low risk: migration only moves files between two local git repos, both keeping full history.

## Open Questions

- None blocking. (Remote name/provisioning for `sunny-data` is Devon's call at deploy time; `media/` may deserve the same treatment later but is explicitly out of scope.)
