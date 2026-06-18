## Context

The bootstrapped foundation (Phases 0–3.5) ships with structured logs and real-model probes, but no checked-in automated tests and no behavioral measurement. The agent already has the seams that make it testable — a swappable `Gateway` driver, an injected `LanguageModel`, Drizzle migrations, a memoized runtime — but nothing exercises them in a deterministic harness, and nothing measures whether the *model's* behavior (speak-only-via-`send_message`, memory recall, tool selection, security gating) holds as prompts and code evolve.

Two qualities of this system shape the design:

1. **Most of the interesting behavior is non-deterministic and costs money.** A turn is an Opus call. Treating "does the agent behave correctly" as ordinary assertions would make CI flaky, slow, and expensive.
2. **Everything DB-backed lives in one Postgres**, and durability runs on the *experimental* Workflow DevKit. Integration tests need real Postgres + migrations; durable-execution tests are bounded by WDK's tooling.

The design splits the problem along the determinism/cost axis: a **deterministic test layer** (free, fast, every commit) and a **behavioral eval layer** (paid, flaky-by-nature, on demand). They share seams but live in separate lanes.

## Goals / Non-Goals

**Goals:**
- A deterministic test suite (unit + integration) that runs on every commit with no paid or external calls, gating merges.
- Reusable seams — mock model, fake gateway, ephemeral Postgres, injectable clock — that let any module be tested in isolation or wired together.
- A behavioral eval harness that drives the *real* loop over a versioned scenario dataset, graded programmatically and by LLM-judge, scored by pass rate with regression tracking.
- Cost discipline: evals never run in the per-commit gate and are budget-capped.

**Non-Goals:**
- Testing third parties (Sendblue's iMessage delivery, Anthropic's API correctness).
- Load/performance/soak testing.
- Making the agent loop deterministic — evals embrace and measure variance rather than eliminate it.
- A bespoke eval *platform/UI* — scorecards are files (+ optional Postgres rows reusing observability), surfaced over the gateway.

## Decisions

### D1: Vitest as the single runner
Vitest over the Node built-in test runner and Jest. Rationale: native ESM/TypeScript (the codebase is TS on a Vite-adjacent Vercel substrate), first-class watch/coverage, and easy mocking. One runner drives both lanes, separated by file glob / config project (`*.unit.test.ts` vs `*.integration.test.ts`) rather than separate tools. *Alternative:* `node --test` — leaner but weaker mocking/coverage ergonomics for this size of suite.

### D2: Mock the model via the AI SDK's test utilities
Use AI SDK v6's `MockLanguageModel` (scripted `LanguageModelV2` responses incl. tool calls) injected at the same seam the real `@ai-sdk/anthropic` model uses. This tests the loop/dispatcher/tool wiring deterministically and for free. *Alternative:* hand-rolled fake — rejected; the SDK mock tracks the real interface and won't drift.

### D3: Fake `Gateway` driver, not a mocked Sendblue HTTP layer
Implement the normalized `Gateway` seam with an in-memory driver that records outbound and exposes an inject-inbound method. Testing at the normalized seam (not Sendblue's wire format) keeps tests stable across transport changes and matches how the gateway is already abstracted. The same fake serves both the test and eval lanes.

### D4: Ephemeral Postgres via Testcontainers (pgvector image), migrated fresh
Integration tests provision a throwaway `pgvector/pgvector:pg16` container, run Drizzle migrations, and tear it down — isolated from the dev `sunny-postgres` and prod. This exercises the *real* tsvector/FTS recall, scheduler tables, and WDK world rather than a SQLite/in-memory stand-in (which wouldn't have FTS). *Alternatives:* (a) shared throwaway schema on the dev DB — faster but risks bleed and can't run in clean CI; (b) transaction-rollback-per-test — fast, but breaks for code that manages its own transactions or the WDK worker. Decision: Testcontainers for correctness; reuse one container across a lane's cases (migrate once, truncate between) for speed. In CI, a Postgres **service container** is the equivalent.

### D5: Injectable clock
Route time through a small clock abstraction (`now()` / scheduler ticks) so tests advance time explicitly. Needed for cron/one-shot scheduling, date-tagged memory facts, and the ~60s ticker — otherwise these tests either sleep or are nondeterministic. Production wires the system clock; tests wire a fake.

### D6: Evals drive the real loop against the fake gateway
The eval harness reuses the fake `Gateway` and the runtime, but swaps the model back to a *real* one (default = production `claude-opus-4-8`; overridable to a cheaper model for fast iteration). A case = setup (seeded memory soul + conversation rows + config) → scripted inbound message(s) → captured outcome (messages, tool calls/results, telemetry). This measures the actual production path, not a reconstruction.

### D7: Cases are versioned data files; graders are code + rubric
Scenario cases live under `evals/cases/**` as human-readable files (YAML/JSON) so they're reviewable in PRs and diffable over time. Two grader kinds:
- **Programmatic** — deterministic assertions on the captured outcome (tool called? `sendCount === 1`? gated action refused? correct `op://` ref resolved? seeded fact recalled?). These carry most of the load.
- **LLM-as-judge** — a rubric-scored judge for fuzzy qualities (tone, helpfulness, appropriate memory use). The judge uses a *different* model than the one under test, and judge model + rubric are versioned with the result to keep scores interpretable.

### D8: Pass-rate scoring, not single-shot equality
Each case runs N times (configurable); the score is the pass rate compared to a per-case/dimension threshold. This is the core accommodation for nondeterminism: a single failing sample is signal, not a red build. Thresholds start lenient and tighten as behavior stabilizes.

### D9: Two CI lanes, evals out of the gate
`typecheck + unit + integration` run on every push/PR (GitHub Actions, Postgres service container) and block merge. Evals run **on demand** (`npm run eval`) or **scheduled** (nightly/weekly), bounded by a cost cap, with scorecards persisted and a summary delivered over the gateway — reusing the `observability` budget meter and insights path. Keeping evals off the per-commit path is what makes the whole scheme affordable and non-flaky.

### D10: Reuse observability for persistence and budgeting
Rather than build a parallel store, eval scorecards persist as JSON artifacts plus (optionally) Postgres rows alongside trajectories, and the eval cost cap is the same budget meter `observability` defines. This change declares the dependency; if `observability` isn't built yet, evals fall back to file-only scorecards and a local cost tally.

## Risks / Trade-offs

- **WDK is experimental; crash-resume is hard to test** → Cover step execution + idempotency at the integration level now; treat full crash/restart-resume as a boundary, expand as WDK's test support matures. Don't block the suite on it.
- **Testcontainers adds CI time and a Docker dependency** → Reuse one container per lane (migrate once, truncate between cases); CI uses a service container. If Docker is ever unavailable, integration lane is skippable while unit + typecheck still gate.
- **LLM-judge graders can be wrong or drift** → Prefer programmatic graders wherever a fact is checkable; reserve judges for genuinely fuzzy qualities; version judge model + rubric; spot-check judge verdicts against human labels periodically.
- **Evals cost money and are noisy** → N-run pass-rate thresholds, a hard budget cap, a cheap-model override for iteration, and exclusion from the per-commit gate.
- **Seams could diverge from production wiring** → Inject mock model / fake gateway / fake clock at the *exact* seams production uses (same runtime composition) so a test path that passes reflects the real path; avoid test-only branches in product code.
- **Eval setup (seeded memory soul) can rot vs real memory format** → Build seeds through the same memory-writer/store APIs the agent uses, not by hand-writing files, so format changes are caught.

## Migration Plan

Additive and incremental; no production behavior changes.
1. Add Vitest + config, the four seams (mock model, fake gateway, ephemeral-Postgres fixture, clock), and a first thin slice of unit + integration tests. Wire the CI gate.
2. Backfill unit/integration coverage across loop, gateway, memory, scheduler, durable steps.
3. Stand up the eval harness + grader interfaces; land a small dataset covering the four dimensions; add `npm run eval` (file-only scorecards).
4. Once `observability` exists, point eval persistence/budget at it and add the scheduled run + gateway delivery.

Rollback: remove the CI lane / scripts; the directories and dev-deps are inert otherwise.

## Open Questions

- **Eval case file format** — YAML vs a typed TS module. YAML is reviewer-friendly and tool-agnostic; TS gives types and reuse of grader code. Leaning YAML for setup/input + a registry of named graders referenced by id.
- **Default eval model & N** — run the dataset on production Opus (truest signal, priciest) vs a cheaper model for routine runs and Opus only for release gates? Likely both, configured per lane.
- **Use an existing eval framework** (e.g. an AI-SDK-compatible evals lib) vs a thin in-house harness — start in-house (small, fully controls the real-loop + gateway integration), revisit if it grows.
- **Where the eval scheduled run lives** — Sunny's own scheduler (dogfood durable jobs) vs external CI cron. Dogfooding is appealing but couples eval health to the system under test.
