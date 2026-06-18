## Why

Sunny acts autonomously on Devon's behalf — spending real money on Opus, sending messages as him, running durable jobs, touching credentials — yet today the foundation has no automated tests and no way to measure whether the agent *behaves* correctly. Two distinct risks follow: (1) ordinary code regressions in the loop, gateway, memory, scheduler, and durable workflows go uncaught, and (2) behavioral regressions — the model stops speaking via `send_message`, recalls memory poorly, picks the wrong tool, or ignores a security gate — are invisible because nothing exercises the model against known-good expectations. We need both a fast deterministic test layer and a separate, cost-aware behavioral eval layer, **with real initial coverage written**, before piling on more capabilities.

## What Changes

- Add a **deterministic test harness** (Vitest) with two lanes: **unit** (pure logic) and **integration** (real modules against an in-process Postgres), and **write the initial coverage** for the existing surface — not just scaffolding.
- Establish **test seams/fakes** so neither lane calls a paid or external service: a **mock language model** (AI SDK `MockLanguageModelV3` from `ai/test` — scripts deterministic tool calls / text), a **fake Gateway driver** (captures outbound, injects inbound — no Sendblue), and an **in-process Postgres** fixture via **PGlite** (real Postgres in WASM — no Docker; runs the actual Drizzle migrations incl. the tsvector/GIN FTS path). Test data comes from **typed builder factories** (deterministic; no faker), with property-based tests (`fast-check`) for the pure normalizers. Time-dependent code is tested via **Vitest fake timers** (no production clock-injection refactor); a small refactor extracts a few pure helpers out of `runTurn` so the D-MG8 delivery logic is unit-testable directly.
- Add an **LLM eval harness** built on **vitest-evals** (Sentry; native AI SDK harness) + **autoevals** (LLM-as-judge + zero-egress heuristics), driving the *real* agent loop against the fake Gateway and asserting on AI SDK's native `result.steps[]` (tool calls/results) plus the loop's `delivered` telemetry. Most checks are **programmatic trajectory assertions**; a cheaper judge model grades fuzzy quality.
- **Write the initial eval dataset** across three dimensions matching Sunny's invariants: `send_message` elicitation, memory recall, and tool selection. (Security gating is deferred — the current focus is owner DMs; it returns alongside the Phase-4 `security-tools-credentials` work.)
- Produce **file-based scorecards** (per-dimension pass rates, model, cost) with a run-over-run regression diff; defer a self-hosted dashboard (Langfuse) until the dataset grows.
- Wire **CI lanes**: typecheck + unit + integration run on every change (free, fast, deterministic); **evals run on demand / scheduled** as a separate Vitest project (cost + flakiness kept out of the default gate), budget-capped.
- Establish a **per-PR definition of done** for coding agents — a change-type → required-test-artifact mapping plus a pull-request template and AGENTS.md checklist — so every behavior-changing PR grows the tests (and, for agent-behavior changes, the eval cases + scorecard evidence), not just the initial backfill.

## Capabilities

### New Capabilities
- `automated-testing`: Deterministic unit + integration test harness, the seams/fakes (mock model, fake gateway, in-process PGlite Postgres, fake-timer time control) that make the agent testable without paid/external calls or Docker, the **initial written coverage** of the current surface, and the CI gate.
- `agent-evals`: Behavioral evaluation of the live agent loop on vitest-evals + autoevals — versioned scenario dataset (elicitation, memory recall, tool selection), programmatic trajectory + LLM-as-judge graders, pass-rate scoring with thresholds, file-based scorecards with regression tracking, and cost controls that keep evals off the per-commit path.

### Modified Capabilities
<!-- None at the spec level. Testing/evals exploit the existing seams (swappable Gateway driver, injected model, Drizzle migrations) without changing their behavior. A small, behavior-preserving refactor extracts pure helpers from the agent loop to make them directly unit-testable; it does not change any requirement. -->

## Impact

- **New dev dependencies**: `vitest` (+ coverage), `vitest-evals`, `autoevals`, `@electric-sql/pglite` (in-process Postgres — no Docker), and `fast-check` (property-based tests for the pure normalizers). Optionally Mastra/agentevals trajectory scorers. **No faker** — fixtures are typed builder factories (D15). No new production dependencies; AI SDK's `ai/test` mocks are already available via `ai`.
- **New directories / scripts**: colocated `*.unit.test.ts` / `*.integration.test.ts`; an `evals/` tree (cases, graders, harness); npm scripts (`test`, `test:integration`, `eval`) and GitHub Actions workflows (a Docker-free merge gate + a manual evals workflow).
- **Small source refactor**: extract delivery-classification / trailing-trim / group-prefix helpers out of `src/agent/loop.ts`'s `runTurn` into exported pure functions (behavior-preserving).
- **Complements `observability`**: when it lands, eval scorecards/cost can move onto its trajectory + budget machinery; until then, scorecards are file-based with a local cost tally.
- **Boundary**: does not test Sendblue's hosted iMessage API or Anthropic itself; no load/perf testing. Durable crash-resume coverage is limited by WDK's experimental test support (called out in design).
