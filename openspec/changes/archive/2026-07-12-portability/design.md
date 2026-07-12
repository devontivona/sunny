# Design: portability

## Context

Developer-authored runtime content is currently embedded in TypeScript and seeded imperatively:

- **Skills**: `src/skills/seeds.ts` holds ~900 lines of `SKILL.md` content as template literals (8 skills, incl. the new `dreaming` skill from context-lifecycle), with binary-ish assets in `src/skills/seed-assets/`. `initSkills()` materializes them write-if-missing into `~/.sunny/skills/authored/` and commits/pushes them into the owner's authored skills repo. Result: two sources of truth — the in-code seed rots once the materialized copy exists, and runtime-coupled skills (`delegation`, `coding`, `browse`, `skill-authoring`, `dreaming`) go stale on deployed machines when the runtime changes.
- **System schedule**: the dreaming job (merged with `context-lifecycle`; replaced `nightly-consolidation`) is seeded insert-once into the Postgres `schedules` table by `ensureDreamSchedule()` (`src/scheduler/index.ts:102`), keyed on `label='dreaming'`: cron `30 */4 * * *`, `outputTarget: 'silent'`, authority `memory_read, memory_write, bash, file_read, file_write`, `threadId` = owner DM computed at seed time. Editing the cron/prompt in code never reaches machines that already hold the row. Seeding is silently skipped when owner identity or `SENDBLUE_FROM_NUMBER` is absent (`src/runtime.ts:249`).
- **Memory starters** (`starterUser`/`starterSunny`/`starterIndex` in `src/memory/index.ts`) and **default config** (`DEFAULT_CONFIG_JSON` in `src/config/index.ts`) are inline strings, seeded write-if-missing — semantically correct, just unreadable/undiffable as code.
- **Fresh-machine gaps** (portability audit, 2026-07-11): WDK world tables require a manual `npx workflow-postgres-setup` documented only in the README, and `WORKFLOW_TARGET_WORLD`/`WORKFLOW_POSTGRES_URL` are missing from `.env.example`; there is no preflight check for env/CLIs/git-auth/DB.
- **Single-machine couplings** (same audit): the dreaming skill seed hardcodes `/home/tivona/projects/sunny` in its CLI instructions (`src/skills/seeds.ts:686,688`) — memory maintenance silently fails from any other clone path; `SendblueGateway`'s constructor throws without all four `SENDBLUE_*` secrets and is constructed unconditionally (`src/gateway/sendblue.ts:98-106`, `src/runtime.ts:127`), so a bare clone cannot boot even in echo mode; outward URLs fall back to `https://sunny.waywardlane.com` when `DASHBOARD_PUBLIC_URL` is unset (`src/dashboard/config.ts:28`, `src/mcp/oauth.ts:79`, `src/gateway/media.ts:277`); state/skill git commits rely on the machine's global git identity and fail silently without one (`src/state/index.ts:76,97`, `src/skills/index.ts:630`); `drizzle/meta/0007/0008` snapshots are untracked (dev-only `drizzle-kit generate` baseline issue).

The organizing principle (converged with the owner): **repo files are authoritative for anything the developer owns; seeding survives only where ownership genuinely transfers to the runtime.** Artifacts are co-located by *mechanism* for human readability.

Constraints:
- Production serves from `.output` with cwd at the repo root; runtime file reads must be cwd-relative (existing precedent: `runMigrations` reads `drizzle/` from cwd).
- The WDK builder sweeps every repo file by content regex; `agent/` content must stay plain markdown/JSON that cannot match the serde patterns.
- The always-on system prefix (skill index included) must remain byte-stable for prompt caching; builtin skill discovery must be deterministic.
- `context-lifecycle` is merged and archived; this change builds directly on its dreaming schedule and skill.

## Goals / Non-Goals

**Goals:**
- One human-readable `agent/` tree: `agent/builtin/` (authoritative, read-in-place) and `agent/seeds/` (write-if-missing templates).
- Delete the skill-seed and schedule-seed mechanisms; builtins update atomically with code deploys.
- `schedules` table becomes purely agent/user-created runtime state.
- Fresh clone + env + start = fully provisioned; `npm run doctor` verifies preconditions; degraded startup warns loudly.

**Non-Goals:**
- No change to the authored/trusted/installed skill classes, the skills repo topology, or the state repo (the two-repo agent surface stays as is).
- No Drizzle schema migration (scope shrink of `schedules` is by convention; see Risks for `schedule_runs` verification).
- No folding of the skills repo into the state repo (discussed, deferred).
- No changes to agent-facing scheduling tools beyond listing/mutation guards for builtins.
- No dashboard redesign — only merging builtin schedules into existing listings.

## Decisions

### D1 — Split `agent/` by mechanism, not by artifact type
`agent/builtin/{skills,schedules}` + `agent/seeds/{memory,config.json}` rather than Eve-style `agent/{skills,schedules,memory}`. The directory name encodes the update semantics (authoritative vs template), which is the thing a reader must not get wrong. Alternative (by type) rejected: it buries the ownership distinction that motivated the change.

### D2 — Builtin skills: new location-trusted, read-only class; no materialization
`src/skills/index.ts` gains a `builtinRoot()` = `<cwd>/agent/builtin/skills`, included in skill discovery alongside `authored/`, `trusted/<slug>/`, `installed/`. Trust is by location (same tier as `trusted/`); the write boundary rejects writes under `builtinRoot` with a "fork into authored" message. `SEED_SKILLS`, `seeds.ts`, `seed-assets/`, and the materialization block in `initSkills()` are deleted. **The builtin cut line** (owner decision, 2026-07-11): a skill ships builtin only when it depends solely on surfaces that ship with Sunny (native tools, the `sunny` CLI, the skill system) — 5 qualify (`dreaming`, `coding`, `delegation`, `find-skills`, `skill-authoring`). Learned capabilities riding host-installed, owner-configured tools (`email`/himalaya, `browse`/agent-browser, `website-builder`/devbox) live solely in the authored skills repo: the skill file alone isn't portable without the tool setup, and their live copies had all genuinely evolved (personal multi-account email etiquette, a growing style/icon library) while the runtime-coupled five had only staleness or one upstreamable lesson. Alternative (reconcile seeds into authored with hash tracking) rejected: keeps two sources of truth and adds bookkeeping to solve a problem read-in-place doesn't have.

### D3 — Shadowing: authored wins, index annotates
Name-collision resolution order: `authored` > `builtin` (fork-to-customize), with `trusted`/`installed` collisions handled as today. The rendered skill index shows one entry per name; a shadowing entry is annotated (e.g. `(shadows builtin)`) so a stale fork is visible. Deterministic ordering preserves the byte-stable prefix. Alternative (builtin wins / collisions are errors) rejected: removes the natural override path on an owner-controlled machine.

### D4 — One-time authored-repo cleanup as a manual script, not boot code
`scripts/cleanup-materialized-seeds.mjs` embeds the content hashes of every shipped seed version (all 28 seeds.ts revisions, plus two hand-verified entries — the upstreamed delegation fork and the stale skill-authoring copy); for each of the 5 builtin names present in `authored/`, it deletes the copy iff every file is byte-identical to the shipped seed (never customized), then commits/pushes via the existing skill-repo git path. Run once by the developer per authored repo (one repo → one run; other machines receive the deletion via the existing ff-only sync). Alternative (boot-time migration with a marker) rejected: permanent runtime code for a one-time event, and hash baggage would outlive its purpose. The script is deleted in a follow-up once run.

### D5 — Builtin schedules: executed from files, never ingested
The scheduler loads `agent/builtin/schedules/*.md` at startup (YAML frontmatter mirroring the `schedules` row shape minus identity/state: `cron`, `outputTarget`, `authority`, optional `audience`/`enabled`; body = run prompt; schedule name = filename). Machine-specific fields are deliberately NOT in the file: `threadId` (owner DM) and timezone are resolved from config at load/fire time — exactly the values `ensureDreamSchedule()` computes today at seed time. Each tick evaluates builtin definitions alongside DB rows using the same cron library, timezone rules, and per-tick dispatch bound, and fires through the same scheduled-run engine (`workflows/scheduledJob.ts`). Run history: `schedule_runs.schedule_id` is an unconstrained `uuid` column, so each builtin schedule gets a **deterministic UUIDv5** derived from its name (stable across machines and restarts, no schema migration); listing/history code maps these ids back to builtin definitions. Boot deletes legacy `dreaming`/`nightly-consolidation` rows from `schedules`. `dreaming.md` carries the exact contract of the merged context-lifecycle seed (cron `30 */4 * * *`, `outputTarget: 'silent'`, authority `memory_read, memory_write, bash, file_read, file_write`, prompt pointing at the dreaming skill). Alternatives rejected: reconcile-into-DB (needs an `origin` column, a reconciler, and delete-detection — more moving parts to express "the file is the truth"); keep insert-once seeding (the staleness bug is the motivation); text synthetic ids like `builtin:dreaming` (blocked by the uuid column type; a type-change migration buys nothing over UUIDv5).

### D6 — Listings merge; mutations guarded; dashboard surfaces both classes
`listSchedules`-style reads (agent tools, dashboard API) return DB rows plus builtin definitions, each tagged with its class; `app/pages/Schedules.tsx` renders the class tag, and run history resolves builtin UUIDs to their names. Update/delete tools reject builtin ids with guidance that builtins change via code deploy. The dashboard Skills page already renders a per-skill trust tier (`app/pages/Skills.tsx`); the skills API's class enum gains `builtin`, and shadowed entries carry the shadow annotation so a stale fork is visible in the UI as well as the index. The anti-recursion guard (scheduled runs can't self-schedule) is unaffected — builtin definitions aren't mutable at runtime by anyone.

### D7 — Seeds become files, mechanism unchanged
`initMemory()` reads `agent/seeds/memory/{USER,SUNNY,INDEX}.md` (via a small cwd-relative reader with an explicit failure if absent — a packaging error, not a soft default) and keeps `seedIfAbsent` semantics. `loadConfig()` reads `agent/seeds/config.json` as the default-config template. Owner-name interpolation in `USER.md` (currently done by `starterUser(name)`) uses a simple `{{ownerName}}` placeholder substituted at materialization time.

### D8 — WDK world setup: programmatic-if-possible, else `npm run setup`
Preferred: call the world-postgres setup entry point idempotently during boot, immediately before `getWorld().start()`. If `@workflow/world-postgres` exposes no stable programmatic setup API, fall back to `npm run setup` = `workflow-postgres-setup && node scripts/doctor.mjs`, and the README's first-run section shrinks to `npm ci && npm run setup && npm run dev:unified`. Either way the step stops being README-only prose. (Task includes verifying the package surface; do not shell out to `npx` from production boot.)

### D9 — Doctor as a plain Node script
`scripts/doctor.mjs` (`npm run doctor`), no runtime imports from `src/` beyond config-path constants — it must run usefully on a half-configured machine. Checks: required env (incl. `WORKFLOW_*` and `DASHBOARD_PUBLIC_URL`), owner identity in `~/.sunny/config.json`, host CLIs on PATH, `git ls-remote` against configured state/skills remotes, DB connectability, WDK tables present, Drizzle journal vs applied migrations, `agent/builtin` present at cwd. Output: one line per check with pass/fail + remediation hint; non-zero exit on required-check failure. The webhook public-URL/tunnel step (Sendblue dashboard "Receive" URL) cannot be auto-verified — the doctor prints it as a reminder and the README documents it as an explicit manual step.

### D10 — Builtin content is machine-agnostic via the `$SUNNY_REPO` convention
Builtin files must not embed machine-specific values. The dreaming skill's `cd /home/tivona/projects/sunny && npx tsx src/cli/index.ts …` instructions become `cd "$SUNNY_REPO" && …`: the agent's bash tool exports `SUNNY_REPO=process.cwd()` into every subprocess env, and the file tools (`file_read`/`file_write`/`file_edit`) expand a leading `$SUNNY_REPO/` in paths. Builtin files are therefore read byte-verbatim (no substitution layer), and the prompt's skills-block text references builtin paths as `$SUNNY_REPO/agent/builtin/skills/<name>/SKILL.md` — fully static, so the cached prefix is byte-stable AND machine-independent. This replaced the originally-planned `{{repoRoot}}` loader substitution, which implementation showed cannot work: skill BODIES are progressive-disclosure — the model reads the SKILL.md itself via `file_read`, so no loader mediates the content. The bash tool's cwd defaults to `config.runtimeDir` (`~/.sunny`), not the repo, which is why the skill genuinely needs the repo path at all. Alternative (ship a `sunny` bin on PATH) deferred: bigger surface, and `$SUNNY_REPO` covers future builtin content generically.

### D11 — Transport-optional boot
`SendblueGateway` is constructed only when the `SENDBLUE_*` secrets are present; when absent, boot continues with the transport disabled and a prominent warning (per first-run-setup "Degraded startup is loud"), leaving echo/test mode, the dashboard, the scheduler, and doctor usable on a bare clone. The builtin-schedule tick likewise skips-with-warning when its owner-DM thread can't be resolved.

### D12 — Machine-agnostic outward URLs and git identity
The `https://sunny.waywardlane.com` fallbacks in `src/dashboard/config.ts`, `src/mcp/oauth.ts`, and `src/gateway/media.ts` are removed: unset `DASHBOARD_PUBLIC_URL`/`PUBLIC_BASE_URL` → loud warning + the dependent feature degrades (no link emitted / OAuth refused / media falls back to non-URL delivery where possible), never another operator's domain. State/skill git commits pass a fixed committer identity (`-c user.name="Sunny" -c user.email=<noreply>`), so persistence works on hosts with no global git config.

### D13 — MCP registry into the state repo; scratch convention (owner decision, 2026-07-11)
The state-vs-DB cut line, made explicit: **files hold definitions and knowledge; the database holds anything mutated by execution.** Two consequences: (1) `mcp.json` is learned knowledge (server URLs/names/purposes + auth references; OAuth tokens stay machine-local under `mcp-oauth/`) and moves to `state/mcp.json` — one-time rename-migration on first read, `mkdir` defensively on write, commit-on-write like credentials — so integrations restore with the state clone. (2) Agent-authored schedules deliberately do NOT move to files: their rows carry per-fire mutable execution state (`nextRunAt`/`lastRunAt`/`active`) under transactional advance-before-dispatch, and `once`/`interval` kinds aren't recomputable from a definition alone; builtins get away with files only because cron + no-backfill makes due-ness clock-derivable. (A dream-maintained backup manifest of recurring schedules in `state/` is noted as a possible follow-up, DB authoritative.) Also: `~/.sunny/scratch/` (machine-local sibling of `state/`, created at boot) is the taught home for working files — observed agent behavior was dropping scratch into the state repo root, polluting synced history.

### D14 — Standing schedules: recurring intents are state-resident files (owner decision, 2026-07-11)
Standing recurring schedules ("wake at 6am and brief me") are identity, like skills and memory — but rows made them machine-mortal. The unlock: the builtin-schedule engine already handles the hard part, because cron + no-backfill makes due-ness clock-derivable — no persisted execution state. So recurring = cron = a file: `state/schedules/<name>.md`, same format/parser/engine as builtins, class-tagged `standing`, ids = UUIDv5 over `(class, name)`. The scheduling tools write/delete the files (commit-on-write; a `FileScheduleRegistry` keeps the live view so creation fires without a restart, first firing at the next cron occurrence). Files carry no machine values: a family member's schedule captures `audience: person:<name>` (a roster reference — the roster deliberately stays in owner-only config, OUTSIDE every agent-writable store; references may cross that boundary, trust anchors may not), default delivery resolves to the owner DM at load time. The `interval` kind is retired from the creation surface (recurring phrasings translate to cron; the live DB has never contained an interval row) — leaving the `schedules` table as pure one-shot reminder state, consumed on fire. Existing cron rows migrate to standing files once at boot (row deleted only after its file commits; the live host's `craft-daily-resource-tagging` is the real migration case). Alternatives rejected: dream-maintained backup manifest (two sources of truth, eventual consistency); thin-prompts-in-skills alone (portable procedure, lost cadence — the cron line IS the identity-bearing part).

## Risks / Trade-offs

- **[Builtin run-history ids collide with a future real schedule row]** → UUIDv5 in a dedicated namespace makes collision with `defaultRandom()` v4 ids practically impossible; resolved (verified: `schedule_runs.schedule_id` is `uuid` with no FK, so no migration is needed).
- **[Stale forks: owner's authored copy shadows an updated builtin]** → index annotation makes shadows visible; acceptable residual risk on a single-owner system.
- **[Builtin schedule fires without required transport/identity config]** → loud startup warning (first-run-setup spec); the tick also skips-with-warning rather than crashing. Standing schedules share the gate (registry disabled + creation refused until transport/identity resolve).
- **[Standing-schedule delivery semantics changed subtly]** → a row delivered to its creating thread; a standing file delivers per audience (owner DM default, `person:<name>` for family subjects, captured at creation). Owner-created recurring schedules from a group thread now deliver to the owner DM — acceptable; cross-checked in workflow tests.
- **[`.output` packaging: `agent/` must exist at runtime cwd]** → same deployment contract as `drizzle/`; doctor checks for `agent/builtin` presence; explicit error (not silent empty index) if missing.
- **[WDK content sweep]** → `agent/` holds only plain markdown/JSON and the existing `skill.mjs` asset (already repo-resident today without incident); no serde-pattern content.
- **[Cleanup script mis-deletes a customized skill]** → byte-identity is conservative by construction; script prints a dry-run diff and requires `--apply`; deletions are a revertable git commit in the skills repo.
- **[Prompt-cache invalidation on deploy]** → builtin content changes alter the skill index and bust the cache once per deploy — identical to today's behavior when skills change; no new cost.

## Migration Plan

1. Branch off current `main` (context-lifecycle is merged and archived; this change deletes `ensureDreamSchedule()` and moves the 8 seed skills, including `dreaming`, to builtins).
2. Ship the `agent/` tree + code changes in one PR; on restart: builtins discovered, legacy schedule rows deleted, seeds untouched on the existing machine (all destinations exist).
3. Run `scripts/cleanup-materialized-seeds.mjs --apply` once against the authored repo; verify the skill index shows builtins (not shadows) for unmodified names.
4. Update README/AGENTS.md (first-run section, layout description, memory-path drift fix).
5. Rollback: revert the PR — builtins vanish in favor of the old seed code path; the cleanup commit in the skills repo is independently revertable (restores materialized copies, which the reverted code treats as authored skills as before).

## Open Questions

- Does `@workflow/world-postgres` expose a programmatic, idempotent setup entry point suitable for boot (D8)? Resolve during implementation; fallback path specified.
