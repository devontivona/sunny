## 1. Test runner & lanes

- [ ] 1.1 Add Vitest + coverage as dev deps; `vitest.config.ts` with projects: unit (`**/*.unit.test.ts`), integration (`**/*.integration.test.ts`, DB setup), and evals (`evals/**`, excluded from default run)
- [ ] 1.2 Add npm scripts: `test` (unit), `test:integration`, `test:all`, `test:watch`, `coverage`, `eval`
- [ ] 1.3 Document in AGENTS.md: the testing conventions (lanes, naming, seams, fake timers); **before pushing**, run the full deterministic suite (`npm run typecheck && npm run test && npm run test:integration` — no Docker needed, integration uses in-process PGlite); **after changing agent behavior** (prompt/loop/tools/model/memory), run `npm run eval` and check the scorecard for regressions

## 2. Seams & fixtures

- [ ] 2.1 Mock language model fixture wrapping `MockLanguageModelV3` + `simulateReadableStream` from `ai/test`; helpers to script text + tool-call sequences; inject at the `getModel()` seam
- [ ] 2.2 Fake `Gateway` driver implementing `src/gateway/types.ts` — records outbound `send`, exposes `injectInbound(...)`, assertable outbound buffer
- [ ] 2.3 In-process Postgres fixture via PGlite (`@electric-sql/pglite` + `drizzle-orm/pglite`): fresh in-memory instance per test file, run Drizzle migrations (incl. the tsvector/GIN SQL migration), expose client, teardown — no Docker; honor optional `TEST_DATABASE_URL` real-PG override
- [ ] 2.4 Runtime test-composition helper wiring the fakes (mock model + fake gateway + ephemeral DB) into the real runtime
- [ ] 2.5 Establish the Vitest fake-timers pattern (`vi.useFakeTimers()` / `vi.setSystemTime()`) for time-dependent tests

## 3. Testability refactor (behavior-preserving)

- [ ] 3.1 Extract pure helpers from `src/agent/loop.ts` `runTurn` — delivery classification (`send_message`/`fallback_text`/`silence`), trailing non-user trim, scratch/sent extraction, group speaker-prefix — as exported functions; `runTurn` calls them (no behavior change)

## 4. Unit lane coverage

- [ ] 4.1 `Authorizer.authorize` + `normalize` (`gateway/auth.ts`): phone/email normalization, owner vs group-nonowner vs unauthorized, `allowGroups` off
- [ ] 4.2 `parseDuration` + `computeNextRun` (`scheduler/index.ts`): once/interval/cron incl. timezone; invalid specs throw
- [ ] 4.3 Memory `computeNext` (add/replace/remove/full-replace), `sanitizeTopic` path-traversal guard, core-file overflow → `MemoryOverflowError` (`memory/index.ts`, temp dir)
- [ ] 4.4 `buildSystemPrompt` (`agent/prompt.ts`): structure snapshot, empty-core → `(empty)`, and byte-stability under unchanged inputs (cache invariant)
- [ ] 4.5 Extracted loop helpers (3.1): delivery classification both ways, trailing-trim, group-prefix
- [ ] 4.6 `ConfigSchema` defaults/validation + `runtimeDir()` `SUNNY_HOME` override (`config/index.ts`)
- [ ] 4.7 `TurnDispatcher` (`agent/dispatcher.ts`): dedup, `SEEN_CAP` eviction, steer-in-flight vs new run, mark-done ordering — with a fake `runTurn` + stub store

## 5. Integration lane coverage

- [ ] 5.1 Migrations apply clean on a fresh DB (incl. generated `text_search` column + GIN index)
- [ ] 5.2 `ConversationStore`: `appendInbound` dedup (`onConflictDoNothing`), `recentWindow` order+limit, `markProcessed`/`findUnprocessedInbound`
- [ ] 5.3 `ConversationStore.recall` tsvector/FTS keyword recall against real Postgres
- [ ] 5.4 Scheduler ticker under fake timers + real DB: due dispatch, `nextRunAt` advance, one-shot deactivation, `scheduleRuns` row, `MAX_PER_TICK`, `ensureConsolidationSchedule` idempotency
- [ ] 5.5 Agent loop end-to-end (mock model + fake gateway + real DB): scripted `send_message` → captured outbound + `delivered:'send_message'` + D-MG9 turn row; scratch-only → `fallback_text` delivered & flagged
- [ ] 5.6 Durable workflow step idempotency: a replayed `memory_write` step applies its effect exactly once, tested against PGlite + the memory fs without standing up the graphile_worker world (full crash-resume is a boundary, gated behind `TEST_DATABASE_URL` real-PG if ever exercised)

## 6. CI (GitHub Actions)

- [ ] 6.1 Integration fixture defaults to in-process PGlite (no env, no Docker); uses `TEST_DATABASE_URL` real Postgres only when explicitly set
- [ ] 6.2 `.github/workflows/ci.yml` (merge gate) on `pull_request` + `push` to `main`: `npm ci` → typecheck → unit → integration; no service container, no Docker, no `ANTHROPIC_API_KEY` (mock model + PGlite → fork-safe, zero API cost)
- [ ] 6.3 `.github/workflows/evals.yml` off the gate: `workflow_dispatch` only, `ANTHROPIC_API_KEY` secret + cost cap + `concurrency` guard, uploads the scorecard artifact
- [ ] 6.4 Configure `main` branch protection to require the `ci.yml` check

## 7. Eval harness (vitest-evals + autoevals)

- [ ] 7.1 Wire vitest-evals with its AI SDK harness driving the real loop against the fake gateway; configurable model (default `claude-opus-4-8`)
- [ ] 7.2 Eval case schema + loader (setup: seeded memory via `applyMemoryWrite`/store APIs, conversation, config; input message(s); grader refs) under `evals/cases/**`
- [ ] 7.3 Programmatic graders over `result.steps` + `delivered`: tool-called / `sendCount` / correct-tool-for-request / fact-recalled
- [ ] 7.4 LLM-as-judge graders via autoevals with a cheaper, independent judge model (e.g. Sonnet/Haiku); record judge model + rubric version
- [ ] 7.5 N-run pass-rate scoring with per-case/dimension thresholds
- [ ] 7.6 File-based scorecard output (per-case + per-dimension pass rates, model, timestamp, cost) + run-over-run regression diff
- [ ] 7.7 Cost-cap enforcement: stop-and-report when an eval run hits its budget
- [ ] 7.8 `npm run eval` entrypoint (select dimension, model, N)

## 8. Eval dataset (three dimensions)

- [ ] 8.1 `send_message` elicitation cases: simple reply, multi-bubble, interview back-and-forth, genuine-silence — assert delivered via `send_message`, never `fallback_text`
- [ ] 8.2 Memory cases: seeded `USER.md` fact used in reply; told-a-durable-fact → `memory_write` to USER with right content; seeded archive → `recall_history` invoked + used (programmatic + one judge for natural use)
- [ ] 8.3 Tool-selection cases: "research X, report back" → `start_job` after an "on it" send; "remind me at 9am" → `schedule_create` w/ plausible spec; trivial greeting → no job/schedule

## 9. Deferred (not in this change)

- [ ] 9.1 Security-gating eval dimension — returns with Phase-4 `security-tools-credentials`
- [ ] 9.2 Move scorecard persistence + eval cost cap onto `observability` (trajectory store + budget meter) once it lands; optionally adopt self-hosted Langfuse for a dashboard/history
