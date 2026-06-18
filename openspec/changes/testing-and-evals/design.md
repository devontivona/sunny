## Context

The bootstrapped foundation (Phases 0–3.5) ships with structured logs and real-model probes, but no checked-in automated tests and no behavioral measurement. The agent is unusually testable already: the core depends only on interfaces (`Gateway`, an injected `LanguageModel`, `Db`), and the loop emits the exact signals an eval needs — `counter.count`, `delivered: 'send_message' | 'fallback_text' | 'silence'`, per-step tool calls, and the persisted turn projection (`src/agent/loop.ts`). What's missing is a deterministic harness that exercises these seams and a behavioral layer that measures whether the *model* holds its invariants as prompts/code evolve.

Two qualities of this system shape the design:

1. **Most interesting behavior is non-deterministic and costs money.** A turn is an Opus call. Treating "does the agent behave correctly" as ordinary assertions would make CI flaky, slow, and expensive.
2. **Everything DB-backed lives in one Postgres**, and durability runs on the *experimental* Workflow DevKit. Integration tests need real Postgres + migrations (the `recall()` FTS path only exists there); durable-execution tests are bounded by WDK's tooling.

The design splits the problem along the determinism/cost axis: a **deterministic test layer** (free, fast, every commit) and a **behavioral eval layer** (paid, flaky-by-nature, on demand). They share seams but live in separate lanes. The eval tooling choice was made after a survey of the mid-2026 TS/AI-SDK eval landscape (see Decisions D6–D7).

## Goals / Non-Goals

**Goals:**
- A deterministic unit + integration suite that runs on every commit with no paid/external calls, gating merges — **with real initial coverage of the current surface written**, not just scaffolding.
- Reusable seams — mock model, fake gateway, in-process Postgres (PGlite), deterministic time — that let any module be tested in isolation or wired together.
- A behavioral eval harness that drives the *real* loop over a versioned dataset, graded by programmatic trajectory assertions + LLM-judge, scored by pass rate with file-based regression tracking.
- Cost discipline: evals never run in the per-commit gate and are budget-capped.

**Non-Goals:**
- Testing third parties (Sendblue delivery, Anthropic's API correctness).
- Load/performance/soak testing.
- Making the agent loop deterministic — evals embrace and measure variance.
- Security-gating evals for now — the current focus is owner DMs; gating evals return with Phase-4 `security-tools-credentials`.
- A bespoke eval platform/UI — scorecards are files; a self-hosted dashboard (Langfuse) is a deferred option, not built here.

## Decisions

### D1: Vitest as the single runner
Vitest over the Node built-in runner and Jest: native ESM/TypeScript, first-class watch/coverage, easy mocking, and — decisively — it's the substrate the chosen eval runner (vitest-evals) builds on. One runner drives unit, integration, and evals, separated by **Vitest projects**/globs (`*.unit.test.ts`, `*.integration.test.ts`, `evals/**`) rather than separate tools.

### D2: Mock the model via the AI SDK's test utilities
Use AI SDK v6's `MockLanguageModelV3` (+ `simulateReadableStream`) from `ai/test` to script deterministic text/tool-calls. This tests the loop/dispatcher/tool wiring for free; the SDK mock tracks the real `LanguageModelV3` interface, so it won't drift from production like a hand-rolled fake would. **Caveat — the injection point doesn't exist yet:** `loop.ts` imports `getModel` directly and `createAgentRunner` has no model dep (`getModel(config)` just returns `anthropic(config.modelId)`, so it can't yield a non-Anthropic mock). D13 adds the narrow DI seam this needs. Note the asymmetry: *evals* select a real model via `config.modelId` and need no DI; only the *mock* requires the seam.

### D3: Fake `Gateway` driver, not a mocked Sendblue HTTP layer
Implement the normalized `Gateway` interface (`src/gateway/types.ts`) with an in-memory driver that records outbound (`send`) and exposes an inject-inbound helper. Testing at the normalized seam — not Sendblue's wire format — keeps tests stable across transport changes and matches how the gateway is already abstracted. The same fake serves both the test and eval lanes.

### D4: In-process Postgres via PGlite — no Docker
Integration tests run against **PGlite** (`@electric-sql/pglite`) — real Postgres compiled to WASM, in-process — using the `drizzle-orm/pglite` driver + migrator to apply the actual Drizzle migrations (incl. the generated `text_search` tsvector column + GIN index). A **fresh in-memory instance per test file** gives perfect isolation with no truncate-between bookkeeping, starts in tens of ms, and needs no daemon, so unit *and* integration run with **zero Docker** — locally, in CI, and on fork PRs.

This was de-risked with a spike against our exact migrations: the FTS generated column, GIN index, the `plainto_tsquery` recall predicate (with English stemming), `jsonb` extraction, and the `onConflictDoNothing` unique-index dedup all work on PGlite. It exercises the *real* FTS/recall path rather than a SQLite stand-in (which has no tsvector).

*Alternatives considered:* **Testcontainers** (`pgvector/pgvector:pg16`) — fully faithful but requires a Docker daemon everywhere it runs, which we explicitly want to avoid; **SQLite** — no tsvector, can't test recall. *Limits:* PGlite is single-connection (fine — our DB tests are sequential; dispatcher concurrency is tested with stubs, not the DB) and pins a specific PG build, but our migrations are vanilla SQL and the spike confirms the dialect we depend on. An optional `TEST_DATABASE_URL` escape hatch points the fixture at a real Postgres for the rare case that needs one (see D5).

### D5: Deterministic time via Vitest fake timers (no clock-injection refactor)
The scheduler/loop/store call `new Date()` / `Date.now()` / `setInterval` directly. Rather than refactor production code to thread an injected clock, tests use **Vitest fake timers** (`vi.useFakeTimers()` + `vi.setSystemTime()`), which mock `Date`, `Date.now`, and `setInterval` globally — enough to test cron/interval math, the `~60s` ticker, and date-tagged behavior without real waiting and with **zero production change**. *Alternative considered:* an injectable clock — cleaner seam but touches several modules for little gain here; revisit only if a specific test proves awkward under fake timers.

### D6: Eval runner — vitest-evals + autoevals (local-first, low lock-in)
Survey conclusion for a self-hosted, no-egress-preferred, *agentic*, Vitest-based project: build on **vitest-evals** (Sentry; Apache-2.0) as the runner and **autoevals** (MIT) for graders.
- **vitest-evals** wraps a dataset + task + scorers into native Vitest tests (`describeEval`), ships a first-class **AI SDK harness** that captures the trajectory (tool calls, usage, spans), and includes `ToolCallJudge`/`FactualityJudge`. 100% local, no SaaS.
- **autoevals** runs standalone with just an API key (no Braintrust account), has **Claude-as-judge verified**, and provides zero-egress heuristics (`Levenshtein`, `ExactMatch`, `EmbeddingSimilarity`) for the deterministic graders.
- Trajectory/order scorers (`@mastra/evals` `toolCallAccuracy` / `trajectory-accuracy`, or `agentevals`) are drop-in standalone functions to add only as specific cases need them.
*Rejected:* **Braintrust** — the platform is closed and ships results to its backend by default (Enterprise-gated self-host), failing the no-egress constraint (its `autoevals` lib is fine à la carte, which is what we use). **Phoenix** (JS evals alpha) and **Laminar** (no trajectory primitive) are weaker TS-agent fits today. A **pure in-house harness** was viable but rebuilds the dataset/scoring/threshold/concurrency plumbing vitest-evals already provides; low lock-in makes the framework the better start.

### D7: Assert on AI SDK `result.steps`; judge with a cheaper, independent model
Most checks are **programmatic trajectory assertions** on the loop's native outputs — `result.steps.flatMap(s => s.toolCalls)`, the `delivered` classification, the persisted projection — which is cheaper and far less flaky than judge-heavy grading. The architecture makes this possible because *speaking is a tool call*, so "did it use `send_message`?" is a fact, not an opinion. LLM-as-judge (autoevals) is reserved for genuinely fuzzy qualities (tone, helpfulness, natural memory use) and uses **Sonnet** — a different, cheaper model than the Opus turn under test — to stay independent and bound cost (D14); the judge model + rubric are versioned with each result.

Graders assert on the **trajectory** (`result.steps` tool calls + the captured outbound), not on database state — note that an owner-DM turn fire-and-forget seeds the nightly-consolidation schedule, so the `schedules` table is never empty during evals; a "no schedule created" check must look at the turn's tool calls, not the table.

### D8: Pass-rate scoring, not single-shot equality
Each case runs N times (configurable); the score is the pass rate vs a per-case/dimension threshold. This is the core accommodation for nondeterminism — a single failing sample is signal, not a red build. Thresholds start lenient and tighten as behavior stabilizes.

### D9: Principle — deterministic lanes gate, evals never do
The merge gate is `typecheck + unit + integration` only; the eval lane is always **on-demand**, never per-commit. This is the load-bearing split: it keeps the gate free, fast, deterministic, and secret-free, while evals (paid, non-deterministic) stay opt-in. D11 is the concrete GitHub Actions implementation; D12 is the per-PR discipline that gets evals run when behavior changes despite their absence from the gate.

### D10: File-based scorecards now; Langfuse deferred
Each eval run writes a JSON scorecard (per-case + per-dimension pass rates, model, timestamp, cost). The **baseline to diff against is a committed file** — `evals/baseline.json` (the last accepted scorecard) — so a run-over-run regression diff works locally, in CI artifacts, and across machines, with no infrastructure. The diff compares the new run to the committed baseline; **updating the baseline is an explicit, reviewed commit** (a behavior PR that moves a dimension's pass rate re-baselines on purpose, in the same PR, visible in review — regressions can't silently rebaseline). This keeps drift honest without a database. A self-hosted **Langfuse** (MIT, fully free self-hosted for evals, offline CI) is the sanctioned escalation *if/when* we want a persistent dashboard, dataset management, and trend history; because datasets + assertions run against AI SDK's portable `result.steps`, adopting it later won't rewrite what evals check. When `observability` lands, scorecard persistence + the eval cost cap can move onto its trajectory/budget machinery.

### D11: GitHub Actions — two workflows, secret-free gate, manual evals
The project is GitHub-hosted, so CI is two Actions workflows:
- **`ci.yml` (the merge gate)** — on `pull_request` + `push` to `main`: `setup-node` (Node 22, npm cache) → `npm ci` → `typecheck` → `unit` → `integration`. No service container and no Docker — integration uses in-process PGlite (D4). It uses the mock model, so it needs **no `ANTHROPIC_API_KEY`** and runs safely on fork PRs at zero API cost. `main` gets **branch protection** requiring this check.
- **`evals.yml` (off the gate)** — `workflow_dispatch` only (no `schedule`): `npm run eval` with the `ANTHROPIC_API_KEY` secret + cost cap and a `concurrency` guard, uploading the JSON scorecard as a build artifact. Manual by choice — cost stays opt-in.

The integration fixture defaults to in-process PGlite (no env, no Docker); `TEST_DATABASE_URL`, if set, points it at a real Postgres — the escape hatch for a full WDK durable-run test, which doesn't run on PGlite (D5). Local + agent process guidance (run the deterministic suite before pushing; run evals after agent-behavior changes) lives in D12's definition of done, not duplicated here.

### D12: Per-PR test/eval discipline — a definition of done for coding agents
The harness and initial coverage are worthless if new work doesn't carry its own tests. Because the gate can only run tests that exist — and evals are off the gate entirely (cost/flakiness) — ongoing coverage is enforced by an explicit **definition of done** that every coding agent (and human) follows, made machine-visible via AGENTS.md and a PR template. The instructions are concrete, not "write good tests": a change-type → required-artifact mapping.

**Change-type → what the same PR must include:**

| Change | Required in the same PR |
|---|---|
| New/changed pure logic (loop helpers, auth, scheduler math, memory, prompt, config) | Unit test(s) covering the new/changed branches |
| New/changed DB query, schema, or migration | Integration test against PGlite (incl. recall/FTS if touched) |
| New/changed **agent behavior** (prompt, loop, tool, model, memory wiring) | Add/extend an eval case for the affected dimension **and** run `npm run eval`, pasting the scorecard delta in the PR |
| New gateway/transport seam or normalization | Unit test (normalization) + integration test if it touches the store |
| Bug fix | A regression test that fails before the fix and passes after |
| Docs/config-only, no behavior change | None — state "no behavior change" in the PR |

**Definition of done (drafted verbatim for AGENTS.md + `.github/pull_request_template.md`):**
- [ ] Deterministic suite green locally: `npm run typecheck && npm run test && npm run test:integration`
- [ ] New/changed behavior has matching unit/integration tests (see table above)
- [ ] Bug fixes include a regression test (fails before, passes after)
- [ ] If **agent behavior** changed: eval case added/updated, `npm run eval` run, and the scorecard delta pasted below — or "N/A: no behavior change"
- [ ] No silent coverage drop for the code this PR touches

This is the seam that turns "tests exist and get run" into "every behavior-changing PR grows the tests and eval evidence." It's enforced by convention + review (the PR template records the eval scorecard since CI can't), not by a hard coverage percentage — judgment over a number. An **informational** coverage report may be surfaced on PRs to make deltas visible to reviewers, but it does not gate merge.

### D13: Narrow DI for the model and the durable-job starter (the seams the loop is missing)
"Drive the real loop with fakes" only works if the loop's two externally-binding collaborators can be replaced. Today both are wired by direct import, so neither can:
- **Model** — `loop.ts` calls `getModel(config)` (a direct import). The mock model (D2) can't be supplied without a seam.
- **Durable start** — `start_job`'s tool `execute` calls `start(runJob)` from `workflow/api` (`src/agent/tools/startJob.ts`), which needs the WDK world (absent on PGlite). Driving the real loop in tests/evals would either throw or launch a real durable job.

Fix: a **behavior-preserving DI refactor** that gives `createAgentRunner` optional overrides — an injected `model` (default `getModel(config)`) and an injected durable `start` (default the real `workflow/api` start, threaded into `createStartJobTool`). Production passes nothing and is unchanged. Then:
- **Unit/integration** inject `MockLanguageModelV3` and a fake start that records the call.
- **Evals** keep the real model (via `config.modelId`) and inject a **recording fake start** — so a tool-selection case grades that the model *chose* `start_job` (it appears in `result.steps`) without executing a durable run. The other tools need no seam: `schedule_*` and `memory_write` write to the test PGlite / temp-fs and are directly assertable.

This is preferred over `vi.mock('./model.js')` / `vi.mock('workflow/api')`: module-mocking works but is opaque and easy to drift, whereas explicit DI keeps the real composition visible and is the same path production uses.

### D14: Eval configuration — TS cases, Opus under test, Sonnet judge
- **Case format: typed TS modules** (not YAML). vitest-evals datasets are TS, and TS gives types on the case/grader shape and lets cases reference grader code directly — worth more than YAML's lighter diffs for a dataset this size. Cases stay versioned, reviewable files under `evals/cases/**`.
- **Model under test: Opus (`claude-opus-4-8`), the production model** — "practice like we play": the eval measures the real production path, not a cheaper proxy. A cheaper model remains overridable per run for fast local iteration, but the default and the baseline are Opus.
- **Judge: Sonnet** — independent from the Opus under test and materially cheaper, while a stronger judge than Haiku for the fuzzy tone/quality calls.
- **N (runs per case): configurable, small default** (≈5) with lenient initial thresholds (D8), tightened as behavior stabilizes — a tuning knob, not an architectural choice.

## Risks / Trade-offs

- **WDK is experimental and doesn't run on PGlite** (graphile_worker needs multi-connection / LISTEN-NOTIFY) → Scope the durable test to **step-function idempotency** — a replayed `memory_write` step applies its effect exactly once — against PGlite + the memory fs, *without* standing up the graphile_worker world. Treat a full crash/restart-resume run as a boundary; if ever wanted it uses the `TEST_DATABASE_URL` real-PG hatch and stays out of the default gate.
- **PGlite pins a specific PG build and is single-connection** → Our migrations are vanilla SQL and the spike confirms the FTS/jsonb/dialect features we depend on; DB tests are sequential, and the only concurrency logic (the dispatcher) is tested with stubs, not the DB. The real-PG hatch remains for anything that needs faithful multi-connection behavior.
- **LLM-judge graders can be wrong or drift** → Prefer programmatic trajectory graders wherever a fact is checkable (the architecture makes most checks factual); reserve judges for fuzzy qualities; version judge model + rubric; spot-check verdicts against human labels periodically.
- **Evals cost money and are noisy** → N-run pass-rate thresholds, a hard budget cap, a cheap-model override for iteration, and exclusion from the per-commit gate.
- **Seams could diverge from production wiring** → Inject the mock model / fake gateway at the *exact* seams production uses (same runtime composition); avoid test-only branches in product code. The one source change (extracting pure helpers from `runTurn`) is behavior-preserving and keeps the real delivery path under test.
- **Eval setup (seeded memory soul) can rot vs real memory format** → Build seeds through the same `applyMemoryWrite`/store APIs the agent uses, not by hand-writing files, so format changes are caught.

## Migration Plan

Additive and incremental; no production behavior changes beyond one behavior-preserving refactor.
1. Add Vitest + config (unit/integration projects), the seams (mock model, fake gateway, in-process PGlite fixture), the D13 DI refactor (inject `model` + durable `start`), and extract the pure helpers (`runTurn` delivery/trim/prefix; `isGroup` threadId parsing). Wire the CI gate.
2. **Write the initial unit coverage** (auth/normalize, scheduler math, memory write/sanitize/overflow, prompt assembly + byte-stability, delivery classification/trim/group-prefix, config, dispatcher) and **integration coverage** (store dedup/window/FTS recall, migrations, scheduler ticker, loop end-to-end with mock model, durable step idempotency).
3. Stand up vitest-evals + autoevals; **write the initial dataset** (elicitation, memory recall, tool selection); add `npm run eval` with file-based scorecards + regression diff.
4. If/when wanted, adopt self-hosted Langfuse for history, and (once `observability` exists) move scorecard persistence/budget onto it.

Rollback: remove the CI lane / scripts; the directories, dev-deps, and the extracted helpers are inert/behavior-preserving otherwise.

## Open Questions

None outstanding at design time. The earlier configuration questions are resolved in D14 (TS cases, Opus under test, Sonnet judge, configurable small N). The only deferred items are explicit non-goals already scoped out: security-gating evals (Phase-4 `security-tools-credentials`) and a full WDK crash-resume test (behind the `TEST_DATABASE_URL` real-PG hatch).
