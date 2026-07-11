# Tasks: portability

## 1. Create the `agent/` tree

- [x] 1.1 Extract the 8 skills (incl. `dreaming`) from `src/skills/seeds.ts` into `agent/builtin/skills/<name>/SKILL.md`, moving `src/skills/seed-assets/` files to their proper `scripts/`, `references/`, `assets/` locations (preserve the 0755 mode on `skill.mjs`); content byte-faithful to the current seeds EXCEPT machine-specific literals — the dreaming skill's hardcoded `/home/tivona/projects/sunny` (seeds.ts:686,688) becomes `$SUNNY_REPO`
- [x] 1.1b Implement the `$SUNNY_REPO` convention (bash tool exports it; file tools expand a leading `$SUNNY_REPO/`) so builtin content never embeds a machine path; grep `agent/builtin/` for remaining absolute paths/usernames/personal hostnames (must be none)
- [x] 1.2 Create `agent/builtin/schedules/dreaming.md` with frontmatter matching the `ensureDreamSchedule()` contract (`cron: "30 */4 * * *"`, `outputTarget: silent`, `authority: [memory_read, memory_write, bash, file_read, file_write]`) and the dreaming prompt as the body; owner-DM thread and timezone are NOT stored — they resolve from config at load/fire time
- [x] 1.3 Extract `starterUser`/`starterSunny`/`starterIndex` from `src/memory/index.ts` into `agent/seeds/memory/{USER,SUNNY,INDEX}.md`, converting the owner-name parameter to a `{{ownerName}}` placeholder
- [x] 1.4 Extract `DEFAULT_CONFIG_JSON` from `src/config/index.ts` into `agent/seeds/config.json`
- [x] 1.5 Add a small cwd-relative `agent/` file reader helper with an explicit packaging-error failure when `agent/builtin` is missing

## 2. Builtin skill class

- [x] 2.1 Add `builtinRoot()` to `src/skills/index.ts`, include it in skill discovery/classification as a trusted, read-only class; ensure deterministic index ordering (byte-stable prefix preserved)
- [x] 2.2 Implement authored-shadows-builtin resolution: one index entry per name, authored wins, entry annotated as shadowing a builtin
- [x] 2.3 Extend the skill write boundary to reject writes under `builtinRoot` with fork-into-authored guidance
- [x] 2.4 Delete `src/skills/seeds.ts`, `src/skills/seed-assets/`, and the seed-materialization block in `initSkills()`; update `src/skills` unit tests (seed tests → builtin discovery/shadowing/write-boundary tests)

## 2b. Dashboard

- [x] 2b.1 Surface the `builtin` class in the dashboard skills API and `app/pages/Skills.tsx` (trust-tier badge + shadow annotation on authored forks)
- [x] 2b.2 Render builtin schedules in `app/pages/Schedules.tsx` with their class tag, and resolve builtin run-history UUIDs to schedule names wherever runs are displayed (Schedules/Jobs/Activity views as applicable)

## 3. Builtin file-defined schedules

- [x] 3.1 Add deterministic builtin schedule ids: UUIDv5 in a dedicated namespace derived from the schedule name (`schedule_runs.schedule_id` is an unconstrained `uuid` — verified, no migration needed), plus the reverse mapping for history/listing lookups
- [x] 3.2 Implement builtin schedule loading in `src/scheduler/index.ts`: parse `agent/builtin/schedules/*.md` frontmatter+body at startup, validate, resolve owner-DM thread + timezone from config, and evaluate due-ness each tick with the same cron/timezone/per-tick-bound logic as DB rows
- [x] 3.3 Fire builtin schedules through the standard scheduled-run engine, recording `schedule_runs` history under the schedule's deterministic UUID
- [x] 3.4 Delete `ensureDreamSchedule()` and its `runtime.ts` call site; add boot-time removal of legacy `dreaming` and `nightly-consolidation` rows
- [x] 3.5 Add the loud startup warning when a builtin schedule's required config (owner identity, transport) is missing, and skip-with-warning at tick time
- [x] 3.6 Merge builtin definitions into schedule listings (agent tools + dashboard API) tagged by class; reject mutations of builtin ids in the scheduling tools with change-by-deploy guidance
- [x] 3.7 Update scheduler unit/integration tests: builtin loading, due-ness, legacy-row cleanup, mutation guard, listing merge

## 4. Seeds from files

- [x] 4.1 Point `initMemory()` at `agent/seeds/memory/` (keep `seedIfAbsent` semantics, apply `{{ownerName}}` substitution at materialization); delete the `starter*` constants (incl. `starterPerson` → `PERSON.md` template); memory unit tests still green
- [x] 4.2 Point `loadConfig()` default-config creation at `agent/seeds/config.json`; delete `DEFAULT_CONFIG_JSON`; update config tests

## 5. One-time authored-repo cleanup

- [x] 5.1 Write `scripts/cleanup-materialized-seeds.mjs`: embedded hashes of the last-shipped content of all 8 seed skills, dry-run diff by default, `--apply` deletes byte-identical copies from `authored/` and commits/pushes via the existing skill-repo git path
- [ ] 5.2 Run the cleanup against the live authored repo (`devontivona/skills`); verify the skill index serves builtins (not shadows) for unmodified names, and intentional forks (if any) are annotated as shadows

## 6. First-run provisioning

- [x] 6.1 Resolve design D8: check whether `@workflow/world-postgres` exposes a programmatic idempotent setup; wire it into boot before `getWorld().start()`, or fall back to `npm run setup` (`workflow-postgres-setup` + doctor)
- [x] 6.2 Write `scripts/doctor.mjs` + `npm run doctor`: required env (incl. `WORKFLOW_TARGET_WORLD`/`WORKFLOW_POSTGRES_URL`, `DASHBOARD_PUBLIC_URL`), owner identity in config, host CLIs, git auth to state/skills remotes, DB reachability, WDK tables, migration currency, `agent/builtin` present; per-check pass/fail + remediation hint, non-zero exit on required failure; print the Sendblue webhook public-URL step as a non-verifiable reminder
- [x] 6.3 Update README first-run section (single setup path, doctor, explicit webhook/tunnel step, timezone default callout) and fix the memory-path drift (`~/.sunny/state/memory/`, README:43); update AGENTS.md with the `agent/` layout
- [x] 6.4 Add `WORKFLOW_TARGET_WORLD` + `WORKFLOW_POSTGRES_URL` to `.env.example`; commit the untracked `drizzle/meta/0007_snapshot.json` + `0008_snapshot.json`

## 6b. De-couple from the original machine (audit findings)

- [x] 6b.1 Transport-optional boot: construct `SendblueGateway` only when all `SENDBLUE_*` secrets are present (`src/gateway/sendblue.ts:98-106`, `src/runtime.ts:127`); otherwise boot with the transport disabled + prominent warning, echo/test channel still functional
- [x] 6b.2 Remove the `https://sunny.waywardlane.com` fallbacks (`src/dashboard/config.ts:28`, `src/mcp/oauth.ts:79`, `src/gateway/media.ts:277`): unset `DASHBOARD_PUBLIC_URL`/`PUBLIC_BASE_URL` → loud warning + feature-level degradation, never a personal-domain URL
- [x] 6b.3 Pass a fixed committer identity (`-c user.name`/`-c user.email`) on all runtime git commits in `src/state/index.ts` and `src/skills/index.ts`, so state/skill persistence works without global git config
- [x] 6b.4 Tests for the above: boot without Sendblue env, outward-URL behavior with unset public URL, commit on a git-identity-less HOME

## 7. Verification

- [x] 7.1 Full test suite + typecheck + local production vite build (production build is not covered by CI)
- [ ] 7.2 Restart the devbox service and smoke-test: skill index includes builtins, dreaming fires from the file definition (or is due-scheduled correctly), legacy rows gone, no seed writes into the authored repo, loud warnings absent on the fully-configured host, dashboard Skills/Schedules pages show both classes
- [x] 7.3 Fresh-machine rehearsal: DONE 2026-07-11 (scratch working-tree copy + scratch SUNNY_HOME + scratch Postgres, no Sendblue secrets): WDK tables auto-provisioned, migrations applied, transport-disabled boot + loud warnings (transport, builtin schedules, public URL), memory/config seeds materialized with the fixed Sunny git identity, /health ok, no machine paths/domains in the scratch home; doctor failed exactly on the missing owner identity. Caught + fixed a real bug: importing @workflow/world-postgres/cli gets bundled by Nitro (CJS __dirname breaks) — setup now runs the package's bin as a child process

## 8. Builtin cut-line refinement (owner decision, 2026-07-11)

- [x] 8.1 Apply the cut line — builtin iff the skill depends only on surfaces that ship with Sunny: keep `dreaming`, `coding`, `delegation`, `find-skills`, `skill-authoring` builtin; remove `email`, `browse`, `website-builder` from `agent/builtin/` (they live solely in the authored skills repo, which already carries their evolved copies)
- [x] 8.2 Upstream the delegation fork's one generic lesson (subagent reports are invisible to the owner — summarize before reacting) into the builtin; fork now byte-identical
- [x] 8.3 Trim the cleanup manifest to the 5 builtin names + add the two hand-verified deletable hashes (upstreamed delegation fork, stale skill-authoring copy) — dry-run now deletes all 5, leaves the 3 learned-capability skills untouched
- [x] 8.4 Update specs/proposal/design + the real-repo builtin-set unit test for the 5/3 split

## 9. MCP registry into state + scratch convention (owner decision, 2026-07-11)

- [x] 9.1 Move the MCP registry to `state/mcp.json`: state-resident path, one-time rename-migration from legacy `~/.sunny/mcp.json` on first read, defensive mkdir on write, commit-on-write via `commitState`; quarantine/atomic-write behavior unchanged (tests updated + migration test added)
- [x] 9.2 Add `scratchDir()` (`~/.sunny/scratch`, machine-local untracked sibling of `state/`), created at boot; prompt (host-tools section) teaches the convention and warns against littering `state/`
- [x] 9.3 runtime-home delta spec: state repo tracks `mcp.json` (references only) + scratch-space requirement; proposal/design updated (D13 records the definitions-vs-execution cut line and why agent schedules stay in the DB)

## 10. Standing schedules (owner decision, 2026-07-11): recurring → state files, one-off → DB

- [x] 10.1 Generalize the builtin machinery: `parseScheduleFile`/`loadScheduleDir`, per-(class,name) `fileScheduleId`, and a live `FileScheduleRegistry` (builtin static + standing mutable; disabled with the same loud gate when the owner-DM thread is unresolvable)
- [x] 10.2 `state/schedules/` as the standing home: `createStanding`/`deleteStanding` write/remove files with commit-on-write; scheduler tick reads the registry live (create fires without restart, first at the next cron occurrence; delete stops firing)
- [x] 10.3 Retire the `interval` kind from the creation surface (tool enum + NL guidance: recurring → cron); `schedule_create` cron → standing file (family subject captured as `audience: person:<name>`), once → DB reminder row; `cancel_run` deletes standing files ownership-scoped and still refuses builtins
- [x] 10.4 Boot migration `migrateCronRowsToStanding`: active cron rows → standing files (fields 1:1, row deleted after commit; live host's `craft-daily-resource-tagging` migrates); interval rows warn-and-keep (none exist)
- [x] 10.5 Listings/dashboard: three classes (`builtin`/`standing`/reminder) tagged in list_runs and the Schedules page; runtime exposes the registry (replaces the static builtin array)
- [x] 10.6 Tests: registry live create/fire/delete, id determinism per class, migration round-trip (scheduler integration); harness gains a real enabled registry; scheduleTools workflow tests updated for the split (family audience capture asserted); also fixed two PRE-EXISTING conversation.workflow.test.ts failures (attachment `required: true` from PR #63, workflow tests not in CI)
- [x] 10.7 Specs: scheduling delta (Schedule types MODIFIED to drop interval; standing-schedules requirement; reminders-only store + migration scenarios), runtime-home delta (state tracks `schedules/`), proposal + design D14

## 11. Close the CI blind spots (owner decision, 2026-07-11)

- [x] 11.1 Add a `workflow-tests` CI job (`npm run test:workflow` — WDK Local World + PGlite, no services, verified key-free) so durable-workflow regressions can't merge silently again
- [x] 11.2 Add a `build` CI job: `dashboard:typecheck` (app/ tsconfig — previously unchecked in CI) + the production unified vite build (previously "build locally before merging"); also exercises the WDK builders' repo sweep at PR time
