## Context

The bootstrapped foundation (Phases 0–3.5) ships with structured logs and real-model probes, but no checked-in automated tests and no behavioral measurement. The agent is unusually testable already: the core depends only on interfaces (`Gateway`, an injected `LanguageModel`, `Db`), and the loop emits the exact signals an eval needs — `counter.count`, `delivered: 'send_message' | 'fallback_text' | 'silence'`, per-step tool calls, and the persisted turn projection (`src/agent/loop.ts`). What's missing is a deterministic harness that exercises these seams and a behavioral layer that measures whether the *model* holds its invariants as prompts/code evolve.

Two qualities of this system shape the design:

1. **Most interesting behavior is non-deterministic and costs money.** A turn is an Opus call. Treating "does the agent behave correctly" as ordinary assertions would make CI flaky, slow, and expensive.
2. **Everything DB-backed lives in one Postgres**, and durability runs on the *experimental* Workflow DevKit. Integration tests need real Postgres + migrations (the `recall()` FTS path only exists there); durable-execution tests are bounded by WDK's tooling.

The design splits the problem along the determinism/cost axis: a **deterministic test layer** (free, fast, every commit) and a **behavioral eval layer** (paid, flaky-by-nature, on demand). They share seams but live in separate lanes. The eval tooling choice was made after a survey of the mid-2026 TS/AI-SDK eval landscape (see Decisions D6–D7).

## Goals / Non-Goals

**Goals:**
- A deterministic unit + integration suite that runs on every commit with no paid/external calls, gating merges — **with real initial coverage of the current surface written**, not just scaffolding.
- Reusable seams — mock model, fake gateway, ephemeral Postgres, deterministic time — that let any module be tested in isolation or wired together.
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
Use AI SDK v6's `MockLanguageModelV3` (+ `simulateReadableStream`) from `ai/test`, injected at the same seam `getModel()` fills with `@ai-sdk/anthropic`. This tests the loop/dispatcher/tool wiring deterministically and for free. The SDK mock tracks the real `LanguageModelV3` interface, so it won't drift from production like a hand-rolled fake would.

### D3: Fake `Gateway` driver, not a mocked Sendblue HTTP layer
Implement the normalized `Gateway` interface (`src/gateway/types.ts`) with an in-memory driver that records outbound (`send`) and exposes an inject-inbound helper. Testing at the normalized seam — not Sendblue's wire format — keeps tests stable across transport changes and matches how the gateway is already abstracted. The same fake serves both the test and eval lanes.

### D4: Ephemeral Postgres via Testcontainers (pgvector image), migrated fresh
Integration tests provision a throwaway `pgvector/pgvector:pg16` container, run the Drizzle migrations (including the SQL migration that adds the generated `text_search` tsvector column + GIN index), and tear it down — isolated from the dev `sunny-postgres` and prod. This exercises the *real* FTS recall, scheduler tables, and dedup constraints rather than a SQLite stand-in (which has no tsvector). Reuse one container across a lane (migrate once, truncate between cases) for speed; in CI, a Postgres **service container** is the equivalent.

### D5: Deterministic time via Vitest fake timers (no clock-injection refactor)
The scheduler/loop/store call `new Date()` / `Date.now()` / `setInterval` directly. Rather than refactor production code to thread an injected clock, tests use **Vitest fake timers** (`vi.useFakeTimers()` + `vi.setSystemTime()`), which mock `Date`, `Date.now`, and `setInterval` globally — enough to test cron/interval math, the `~60s` ticker, and date-tagged behavior without real waiting and with **zero production change**. *Alternative considered:* an injectable clock — cleaner seam but touches several modules for little gain here; revisit only if a specific test proves awkward under fake timers.

### D6: Eval runner — vitest-evals + autoevals (local-first, low lock-in)
Survey conclusion for a self-hosted, no-egress-preferred, *agentic*, Vitest-based project: build on **vitest-evals** (Sentry; Apache-2.0) as the runner and **autoevals** (MIT) for graders.
- **vitest-evals** wraps a dataset + task + scorers into native Vitest tests (`describeEval`), ships a first-class **AI SDK harness** that captures the trajectory (tool calls, usage, spans), and includes `ToolCallJudge`/`FactualityJudge`. 100% local, no SaaS.
- **autoevals** runs standalone with just an API key (no Braintrust account), has **Claude-as-judge verified**, and provides zero-egress heuristics (`Levenshtein`, `ExactMatch`, `EmbeddingSimilarity`) for the deterministic graders.
- Trajectory/order scorers (`@mastra/evals` `toolCallAccuracy` / `trajectory-accuracy`, or `agentevals`) are drop-in standalone functions to add only as specific cases need them.
*Rejected:* **Braintrust** — the platform is closed and ships results to its backend by default (Enterprise-gated self-host), failing the no-egress constraint (its `autoevals` lib is fine à la carte, which is what we use). **Phoenix** (JS evals alpha) and **Laminar** (no trajectory primitive) are weaker TS-agent fits today. A **pure in-house harness** was viable but rebuilds the dataset/scoring/threshold/concurrency plumbing vitest-evals already provides; low lock-in makes the framework the better start.

### D7: Assert on AI SDK `result.steps`; judge with a cheaper, independent model
Most checks are **programmatic trajectory assertions** on the loop's native outputs — `result.steps.flatMap(s => s.toolCalls)`, the `delivered` classification, the persisted projection — which is cheaper and far less flaky than judge-heavy grading. The architecture makes this possible because *speaking is a tool call*, so "did it use `send_message`?" is a fact, not an opinion. LLM-as-judge (autoevals) is reserved for genuinely fuzzy qualities (tone, helpfulness, natural memory use) and uses a **different, cheaper model** than the one under test (e.g. Sonnet/Haiku judging an Opus turn) to stay independent and bound cost; the judge model + rubric are versioned with each result.

### D8: Pass-rate scoring, not single-shot equality
Each case runs N times (configurable); the score is the pass rate vs a per-case/dimension threshold. This is the core accommodation for nondeterminism — a single failing sample is signal, not a red build. Thresholds start lenient and tighten as behavior stabilizes.

### D9: Two CI lanes, evals out of the gate
`typecheck + unit + integration` run on every push/PR (GitHub Actions, Postgres service container) and block merge. Evals run **on demand** (`npm run eval`) or **scheduled**, as a separate Vitest project, bounded by a cost cap. Keeping evals off the per-commit path is what makes the scheme affordable and non-flaky.

### D10: File-based scorecards now; Langfuse deferred
Each eval run writes a JSON scorecard (per-case + per-dimension pass rates, model, timestamp, cost) plus a run-over-run regression diff — enough to catch behavioral drift without standing up infrastructure. A self-hosted **Langfuse** (MIT, fully free self-hosted for evals, offline CI) is the sanctioned escalation *if/when* we want a persistent dashboard, dataset management, and trend history; because datasets + assertions run against AI SDK's portable `result.steps`, adopting it later won't rewrite what evals check. When `observability` lands, scorecard persistence + the eval cost cap can move onto its trajectory/budget machinery.

## Risks / Trade-offs

- **WDK is experimental; crash-resume is hard to test** → Cover step execution + idempotency (a replayed `memory_write` step doesn't double-append) at the integration level now; treat full crash/restart-resume as a boundary. Don't block the suite on it.
- **Testcontainers adds CI time and a Docker dependency** → Reuse one container per lane (migrate once, truncate between); CI uses a service container. If Docker is unavailable, the integration lane is skippable while unit + typecheck still gate.
- **LLM-judge graders can be wrong or drift** → Prefer programmatic trajectory graders wherever a fact is checkable (the architecture makes most checks factual); reserve judges for fuzzy qualities; version judge model + rubric; spot-check verdicts against human labels periodically.
- **Evals cost money and are noisy** → N-run pass-rate thresholds, a hard budget cap, a cheap-model override for iteration, and exclusion from the per-commit gate.
- **Seams could diverge from production wiring** → Inject the mock model / fake gateway at the *exact* seams production uses (same runtime composition); avoid test-only branches in product code. The one source change (extracting pure helpers from `runTurn`) is behavior-preserving and keeps the real delivery path under test.
- **Eval setup (seeded memory soul) can rot vs real memory format** → Build seeds through the same `applyMemoryWrite`/store APIs the agent uses, not by hand-writing files, so format changes are caught.

## Migration Plan

Additive and incremental; no production behavior changes beyond one behavior-preserving refactor.
1. Add Vitest + config (unit/integration projects), the seams (mock model, fake gateway, ephemeral-Postgres fixture), and extract the pure helpers from `runTurn`. Wire the CI gate.
2. **Write the initial unit coverage** (auth/normalize, scheduler math, memory write/sanitize/overflow, prompt assembly + byte-stability, delivery classification/trim/group-prefix, config, dispatcher) and **integration coverage** (store dedup/window/FTS recall, migrations, scheduler ticker, loop end-to-end with mock model, durable step idempotency).
3. Stand up vitest-evals + autoevals; **write the initial dataset** (elicitation, memory recall, tool selection); add `npm run eval` with file-based scorecards + regression diff.
4. If/when wanted, adopt self-hosted Langfuse for history, and (once `observability` exists) move scorecard persistence/budget onto it.

Rollback: remove the CI lane / scripts; the directories, dev-deps, and the extracted helpers are inert/behavior-preserving otherwise.

## Open Questions

- **Eval case file format** — YAML vs a typed TS module. YAML is reviewer-friendly; TS gives types and reuse of grader code. vitest-evals leans toward TS datasets, which may settle this toward TS.
- **Default eval model & N** — production Opus for the truest signal vs a cheaper model for routine runs with Opus reserved for release gates. Likely both, configured per lane.
- **Judge model** — Sonnet vs Haiku for the autoevals judge; trade grading fidelity against cost.
- **Where the scheduled eval run lives** — Sunny's own scheduler (dogfood durable jobs) vs external CI cron. Dogfooding couples eval health to the system under test.
