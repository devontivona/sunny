# Proposal: portability

## Why

Sunny's developer-authored defaults are scattered across mechanisms that don't match their ownership semantics: ~900 lines of skill markdown live as TypeScript template literals (`src/skills/seeds.ts`, 8 skills), the memory starters and default config are inline strings, and the one system schedule (`dreaming`, which context-lifecycle just landed as the replacement for `nightly-consolidation`) is an insert-once DB seed that goes stale the moment the code's version changes — the same runtime-coupling staleness that already bit the seed skills (e.g. `delegation` describing an old authority model). Additionally, a portability audit confirmed the project has accreted single-machine couplings: a fresh install has hidden manual steps (WDK world tables; `WORKFLOW_*` vars absent from `.env.example`), hard failures (boot crashes without all four `SENDBLUE_*` secrets, even in echo mode), and silent degradations (the dreaming skill seed hardcodes `/home/tivona/projects/sunny`, so memory maintenance breaks off-host; outward URLs fall back to the personal domain `sunny.waywardlane.com`; state/skill git commits assume a machine git identity and silently stop persisting without one) — undermining the goal that the repo be re-runnable anywhere.

## What Changes

- **New git-committed authored surface `agent/`**, split by mechanism for human readability:
  - `agent/builtin/` — developer-owned, authoritative, read in place at runtime, never copied into `~/.sunny`:
    - `agent/builtin/skills/<name>/SKILL.md` (+ `scripts/`) — the 5 runtime-coupled skills from `src/skills/seeds.ts` (`dreaming`, `coding`, `delegation`, `find-skills`, `skill-authoring`). The cut line: builtin iff the skill depends only on surfaces that ship with Sunny; learned capabilities riding host-installed tools (`email`/himalaya, `browse`/agent-browser, `website-builder`/devbox) live solely in the authored skills repo, which already carries their evolved copies
    - `agent/builtin/schedules/<name>.md` — system schedules (cron/authority/output frontmatter, prompt body); currently just `dreaming`
  - `agent/seeds/` — write-if-missing templates whose ownership transfers to the runtime:
    - `agent/seeds/memory/USER.md`, `SUNNY.md`, `INDEX.md` (from the `starter*` constants in `src/memory/index.ts`)
    - `agent/seeds/config.json` (from `DEFAULT_CONFIG_JSON` in `src/config/index.ts`)
- **New `builtin` skill class**: read directly from the repo, trusted by location, read-only (write boundary rejects edits, as for `trusted/` clones). An `authored/` skill with the same name shadows the builtin (fork-to-customize); the skill index annotates shadows. **BREAKING (internal)**: the seed-skill materialization mechanism (`SEED_SKILLS` write-if-missing into `authored/`) is deleted.
- **Recurring schedules are files; the DB keeps only one-shot reminders**: two file classes — `agent/builtin/schedules/*.md` (system jobs; `ensureDreamSchedule()` deleted, legacy rows removed at boot) and `~/.sunny/state/schedules/*.md` (**standing** schedules: the agent's recurring intents, created/deleted live by the scheduling tools with commit-on-write — portable identity, restored with the state clone). The `interval` kind is retired (recurring = cron; the live DB never held an interval row); existing cron rows migrate to standing files once at boot. Run history for file schedules lands in `schedule_runs` under stable per-(class,name) UUIDs. Listings (dashboard, agent tools) merge all three classes. The silent skip when owner identity / `SENDBLUE_FROM_NUMBER` is missing becomes a loud startup warning.
- **Dashboard surfaces both classes**: the Skills page's trust tier gains `builtin` (with shadow annotation for authored forks), and the Schedules page lists builtin file-defined schedules alongside persisted ones, tagged by class.
- **One-time authored-repo cleanup**: previously materialized copies of the 5 builtin-name skills are removed from the authored repo when byte-identical to a shipped version (or hand-verified stale/upstreamed); genuinely modified copies stay as intentional forks. The 3 learned-capability skills stay in the authored repo untouched — it is their home now.
- **First-run provisioning hardening**: WDK world-table setup folded into an idempotent boot/setup step; new `npm run doctor` that checks required env, owner identity, host CLIs, git auth + identity, DB reachability, WDK tables, and migration currency; README drift fixed (memory path is `~/.sunny/state/memory/`; webhook public-URL step made explicit).
- **De-coupling from the original machine** (audit findings):
  - Builtin content must be machine-agnostic: the dreaming skill's hardcoded `/home/tivona/projects/sunny` becomes `$SUNNY_REPO` (exported into the agent's bash env; expanded by the file tools).
  - Boot without transport: missing `SENDBLUE_*` secrets disable the transport with a loud warning instead of crashing the boot (echo/test mode stays usable on a bare clone).
  - No personal-domain fallbacks: when `DASHBOARD_PUBLIC_URL` is unset, approve links / MCP OAuth / media URLs warn and degrade instead of silently pointing at `sunny.waywardlane.com`.
  - State/skill git commits use a fixed committer identity (`-c user.name/email`) instead of assuming machine git config.
  - `.env.example` gains `WORKFLOW_TARGET_WORLD` + `WORKFLOW_POSTGRES_URL`; untracked `drizzle/meta/0007/0008` snapshots get committed.
- **MCP registry moves into the state repo**: `~/.sunny/mcp.json` (server URLs/names/purposes + auth references — never tokens) relocates to `~/.sunny/state/mcp.json` with a one-time migration and commit-on-write, so learned integrations restore on a fresh host with the state clone (OAuth re-authorizes per machine).
- **Scratch convention**: `~/.sunny/scratch/` (machine-local, untracked, created at boot) is the home for the agent's temporary/working files; the prompt teaches it, so throwaway files stop landing in the state repo's synced history.

## Capabilities

### New Capabilities
- `builtin-surface`: the git-committed `agent/` directory layout and its two mechanisms — `builtin/` artifacts that are authoritative and read in place, and `seeds/` templates that materialize write-if-missing exactly once.
- `first-run-setup`: fresh-machine provisioning — idempotent WDK world setup, the `doctor` preflight check, transport-optional boot, machine-agnostic outward URLs and git identity, and loud (not silent) degradation when required identity/transport configuration is absent.

### Modified Capabilities
- `agent-skills`: adds the `builtin` skill class (repo-resident, trusted, read-only, never materialized), authored-shadows-builtin resolution with index annotation, and removes the seed-materialization requirement.
- `scheduling`: recurring schedules are file-defined — builtin (repo) and standing (state repo, tool-mutable, live without restart); the persisted store holds only one-shot reminders; the `interval` kind is retired; legacy cron rows migrate to files; listings merge three classes.
- `runtime-home`: the state repository additionally tracks `mcp.json` (references only; commit-on-write; legacy location migrates), and `~/.sunny/scratch/` becomes the taught convention for temporary working files.

## Impact

- **Code**: `src/skills/seeds.ts` and `src/skills/seed-assets/` deleted in favor of `agent/builtin/skills/`; `src/skills/index.ts` (skill discovery, trust classes, write boundary, index rendering); `src/scheduler/index.ts` (file-defined schedule execution, `ensureDreamSchedule` removal); `src/memory/index.ts` (starters from files); `src/config/index.ts` (default config from file); `src/runtime.ts` (boot order, warnings, WDK setup, transport-optional gateway construction); `src/gateway/sendblue.ts`; `src/dashboard/config.ts`, `src/mcp/oauth.ts`, `src/gateway/media.ts` (URL fallbacks); `src/state/index.ts` + `src/skills/index.ts` (git committer identity); dashboard skill/schedule endpoints + `app/pages/Skills.tsx` / `Schedules.tsx`.
- **Data**: no Drizzle schema change required — `schedule_runs.schedule_id` is an unconstrained `uuid`, so builtin runs use a deterministic per-name UUID; the `schedules` table shrinks in scope by convention; one-time cleanup commits to the authored skills repo (`devontivona/skills`).
- **Constraints**: production serves from `.output` with cwd at the repo root — `agent/` is read via cwd-relative paths (same pattern as `drizzle/`); builtin files must stay plain markdown with no WDK-serde-looking content (the WDK builder sweeps all repo files by content regex); builds on the merged `context-lifecycle` change (dreaming schedule + dreaming skill).
- **Docs**: README first-run section, AGENTS.md layout description.
