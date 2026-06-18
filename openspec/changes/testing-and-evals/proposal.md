## Why

Sunny acts autonomously on Devon's behalf — spending real money on Opus, sending messages as him, running durable jobs, touching credentials — yet today the foundation has no automated tests and no way to measure whether the agent *behaves* correctly. Two distinct risks follow: (1) ordinary code regressions in the loop, gateway, memory, scheduler, and durable workflows go uncaught, and (2) behavioral regressions — the model stops speaking via `send_message`, recalls memory poorly, picks the wrong tool, or ignores a security gate — are invisible because nothing exercises the model against known-good expectations. We need both a fast deterministic test layer and a separate, cost-aware behavioral eval layer before piling on more capabilities.

## What Changes

- Add a **deterministic test harness** (Vitest) with two lanes: **unit** (pure logic — prompt assembly, trailing-message trimming, memory fact parsing/date-tagging, cron math, auth/owner matching, gateway normalization) and **integration** (real modules against ephemeral infra — Postgres via disposable container + fresh migrations, FTS recall, scheduler ticker, durable-workflow steps).
- Establish **test seams/fakes** so neither lane calls a paid or external service: a **mock language model** (scripted AI SDK `LanguageModelV2` — deterministic tool calls / text), a **fake Gateway driver** (captures outbound, injects inbound — no Sendblue), an **ephemeral Postgres** fixture, and an **injectable clock** for time-dependent code.
- Add an **LLM eval harness** that drives the *real* agent loop against the fake Gateway with a real (or configurable) model, over a **versioned scenario dataset**, scored by **programmatic graders** (deterministic assertions) and **LLM-as-judge graders** (rubric-based quality), producing a persisted **scorecard** with pass-rate thresholds and regression tracking.
- Define **eval dimensions** matching Sunny's invariants: `send_message` elicitation, memory recall, tool selection, and security gating.
- Wire **CI lanes**: typecheck + unit + integration run on every change (free, fast, deterministic); **evals run on demand / scheduled** (cost + flakiness kept out of the default gate), budget-capped, with results delivered over the gateway.

## Capabilities

### New Capabilities
- `automated-testing`: Deterministic unit + integration test harness, the seams/fakes (mock model, fake gateway, ephemeral Postgres, injectable clock) that make the agent testable without paid/external calls, and the CI gate.
- `agent-evals`: Behavioral evaluation of the live agent loop — versioned scenario dataset, programmatic + LLM-as-judge graders, pass-rate scoring with thresholds and regression tracking, and cost controls that keep evals off the per-commit path.

### Modified Capabilities
<!-- None. Testing/evals exploit the existing seams (swappable Gateway driver, injected model, Drizzle migrations) without changing their spec-level behavior. New testability requirements live in the new capabilities above. -->

## Impact

- **New dev dependencies**: Vitest (runner/coverage), AI SDK test utilities (`MockLanguageModel`), an ephemeral-Postgres mechanism (Testcontainers or a disposable Docker pg), and a YAML/JSON loader for eval cases. No new production dependencies.
- **New directories**: colocated `*.test.ts` (or `tests/`) for unit/integration; `evals/` for the scenario dataset, graders, and harness. New `npm` scripts (`test`, `test:integration`, `eval`) and a GitHub Actions workflow with a Postgres service container.
- **Complements `observability`**: eval scorecards and the per-run cost cap reuse the budget meter / trajectory machinery defined there; eval results surface through the same gateway insights path.
- **Boundary**: does not test Sendblue's hosted iMessage API or Anthropic itself; no load/perf testing. Durable crash-resume coverage is limited by WDK's experimental test support (called out in design).
