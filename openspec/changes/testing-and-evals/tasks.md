## 1. Test runner & lanes

- [ ] 1.1 Add Vitest + coverage as dev deps; `vitest.config.ts` with projects: unit (`**/*.unit.test.ts`), integration (`**/*.integration.test.ts`, DB setup), and evals (`evals/**`, excluded from default run)
- [ ] 1.2 Add npm scripts: `test` (unit), `test:integration`, `test:all`, `test:watch`, `coverage`, `eval`
- [ ] 1.3 Document in AGENTS.md: the testing conventions (lanes, naming, seams, fake timers); the **definition of done** + change-type→test-artifact table (design D12); **before pushing**, run the full deterministic suite (`npm run typecheck && npm run test && npm run test:integration` — no Docker needed, integration uses in-process PGlite); **after changing agent behavior** (prompt/loop/tools/model/memory), add/extend an eval case, run `npm run eval`, and put the scorecard delta in the PR
- [ ] 1.4 Add `.github/pull_request_template.md` with the definition-of-done checklist (deterministic suite green; matching tests for changed behavior; regression test for bug fixes; eval case + scorecard delta for behavior changes, or "N/A: no behavior change")

## 2. Seams & fixtures

- [ ] 2.1 Mock language model fixture wrapping `MockLanguageModelV3` + `simulateReadableStream` from `ai/test`; helpers to script text + tool-call sequences; inject at the `getModel()` seam
- [ ] 2.2 Fake `Gateway` driver implementing `src/gateway/types.ts` — records outbound `send`, exposes `injectInbound(...)`, assertable outbound buffer
- [ ] 2.3 In-process Postgres fixture via PGlite (`@electric-sql/pglite` + `drizzle-orm/pglite`): fresh in-memory instance per test file, run Drizzle migrations (incl. the tsvector/GIN SQL migration), expose client, teardown — no Docker; honor optional `TEST_DATABASE_URL` real-PG override
- [ ] 2.4 Recording fake durable-`start` (records `start_job` invocations without launching a WDK job) for tests + evals (D13)
- [ ] 2.5 Runtime test-composition helper wiring the fakes (mock/real model + fake gateway + in-process PGlite + fake durable-start) into the real runtime
- [ ] 2.6 Establish the Vitest fake-timers pattern (`vi.useFakeTimers()` / `vi.setSystemTime()`) for time-dependent tests

## 3. Testability refactor (behavior-preserving, D13)

- [ ] 3.1 Extract pure helpers from `src/agent/loop.ts` `runTurn` — delivery classification (`send_message`/`fallback_text`/`silence`), trailing non-user trim, scratch/sent extraction, group speaker-prefix — as exported functions; `runTurn` calls them (no behavior change)
- [ ] 3.2 Add narrow DI to `createAgentRunner`: optional injected `model` (default `getModel(config)`) and injected durable `start` threaded into `createStartJobTool` (default the real `workflow/api` start); production passes nothing
- [ ] 3.3 Extract the `isGroup` threadId derivation (`threadId.split(':')[2] === 'g'`) — currently duplicated in `gateway/sendblue.ts` and `gateway/store.ts` — into one shared pure helper

## 4. Unit lane coverage

- [ ] 4.1 `Authorizer.authorize` + `normalize` (`gateway/auth.ts`): phone/email normalization, owner vs group-nonowner vs unauthorized, `allowGroups` off
- [ ] 4.2 `parseDuration` + `computeNextRun` (`scheduler/index.ts`): once/interval/cron incl. timezone; invalid specs throw
- [ ] 4.3 Memory `computeNext` (add/replace/remove/full-replace), `sanitizeTopic` path-traversal guard, core-file overflow → `MemoryOverflowError` (`memory/index.ts`, temp dir)
- [ ] 4.4 `buildSystemPrompt` (`agent/prompt.ts`): structure snapshot, empty-core → `(empty)`, and byte-stability under unchanged inputs (cache invariant)
- [ ] 4.5 Extracted loop helpers (3.1): delivery classification all three ways, trailing-trim, group-prefix; legacy pre-D-MG9 row reconstruction (`rowToUIMessage` no-payload branch)
- [ ] 4.6 `ConfigSchema` defaults/validation + `runtimeDir()` `SUNNY_HOME` override (`config/index.ts`)
- [ ] 4.7 `TurnDispatcher` (`agent/dispatcher.ts`): dedup, `SEEN_CAP` eviction, steer-in-flight vs new run, mark-done ordering — with a fake `runTurn` + stub store
- [ ] 4.8 Gateway inbound normalization: the shared `isGroup` threadId derivation (3.3) over DM vs group vs malformed thread ids

## 5. Integration lane coverage

- [ ] 5.1 Migrations apply clean on a fresh DB (incl. generated `text_search` column + GIN index)
- [ ] 5.2 `ConversationStore`: `appendInbound` dedup (`onConflictDoNothing`), `recentWindow` order+limit, `markProcessed`/`findUnprocessedInbound`
- [ ] 5.3 `ConversationStore.recall` tsvector/FTS keyword recall against real Postgres
- [ ] 5.4 Scheduler ticker under fake timers + real DB: due dispatch, `nextRunAt` advance, one-shot deactivation, `scheduleRuns` row, `MAX_PER_TICK`, `ensureConsolidationSchedule` idempotency
- [ ] 5.5 Agent loop end-to-end (mock model + fake gateway + PGlite): scripted `send_message` → captured outbound + `delivered:'send_message'` + D-MG9 turn row; scratch-only → `fallback_text` delivered & flagged; mock model throws → user gets the error reply and the dispatcher survives
- [ ] 5.6 `ConversationStore.appendOutbound` proactive send: standalone outbound row + `assistantSendPayload` shape (the Tier-2/scheduled delivery path)
- [ ] 5.7 Runtime restart recovery: an un-`processedAt` inbound is re-enqueued on startup (`findUnprocessedInbound` → dispatcher), an already-processed one is not
- [ ] 5.8 Durable workflow step idempotency: a replayed `memory_write` step applies its effect exactly once, tested against PGlite + the memory fs without standing up the graphile_worker world (full crash-resume is a boundary, gated behind `TEST_DATABASE_URL` real-PG if ever exercised)

## 6. CI (GitHub Actions)

- [ ] 6.1 Integration fixture defaults to in-process PGlite (no env, no Docker); uses `TEST_DATABASE_URL` real Postgres only when explicitly set
- [ ] 6.2 `.github/workflows/ci.yml` (merge gate) on `pull_request` + `push` to `main`: `npm ci` → typecheck → unit → integration; no service container, no Docker, no `ANTHROPIC_API_KEY` (mock model + PGlite → fork-safe, zero API cost)
- [ ] 6.3 `.github/workflows/evals.yml` off the gate: `workflow_dispatch` only, `ANTHROPIC_API_KEY` secret + cost cap + `concurrency` guard, uploads the scorecard artifact
- [ ] 6.4 Configure `main` branch protection to require the `ci.yml` check
- [ ] 6.5 Surface an informational coverage report on PRs (visible to reviewers; not a merge-gating threshold)

## 7. Eval harness (vitest-evals + autoevals)

- [ ] 7.1 Wire vitest-evals driving the real loop against the fake gateway + the recording fake durable-`start` (2.4); model via `config.modelId` (default `claude-opus-4-8`); graders read the captured trajectory, not DB state
- [ ] 7.2 Eval case schema + loader as typed TS modules under `evals/cases/**` (setup: seeded memory via `applyMemoryWrite`/store APIs, conversation, config, `isOwner`/`isGroup`; input message(s); grader refs)
- [ ] 7.3 Programmatic graders over `result.steps` + `delivered`: tool-called / `sendCount` / correct-tool-for-request / fact-recalled
- [ ] 7.4 LLM-as-judge graders via autoevals with Sonnet as the independent judge (cheaper than the Opus under test); record judge model + rubric version
- [ ] 7.5 N-run pass-rate scoring (configurable N, default ≈5) with per-case/dimension thresholds, lenient to start
- [ ] 7.6 File-based scorecard output (per-case + per-dimension pass rates, model, timestamp, cost); diff each run against the committed `evals/baseline.json` baseline; updating the baseline is an explicit, reviewed commit (D10)
- [ ] 7.7 Cost-cap enforcement: stop-and-report when an eval run hits its budget
- [ ] 7.8 `npm run eval` entrypoint (select dimension, model, N)

## 8. Eval dataset (three dimensions)

- [ ] 8.1 `send_message` elicitation — speak cases (simple reply, multi-bubble, interview back-and-forth): assert reply delivered via `send_message`, `fallback_text` never fires
- [ ] 8.2 `send_message` elicitation — silence case (nothing genuinely worth saying): assert `delivered:'silence'` — no send and no `fallback_text` (correct restraint, not a missed reply)
- [ ] 8.3 Memory cases: seeded `USER.md` fact used in reply; told-a-durable-fact → `memory_write` to USER with right content; seeded archive → `recall_history` invoked + used (programmatic + one judge for natural use)
- [ ] 8.4 Tool-selection cases (assert on tool calls in the trajectory): "research X, report back" → `start_job` after an "on it" send; "remind me at 9am" → `schedule_create` w/ plausible spec; trivial greeting → no `start_job`/`schedule_create`

## 9. Deferred (not in this change)

- [ ] 9.1 Security-gating eval dimension — returns with Phase-4 `security-tools-credentials`
- [ ] 9.2 Move scorecard persistence + eval cost cap onto `observability` (trajectory store + budget meter) once it lands; optionally adopt self-hosted Langfuse for a dashboard/history
