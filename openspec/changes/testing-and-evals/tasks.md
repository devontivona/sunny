## 1. Test runner & lanes

- [ ] 1.1 Add Vitest + coverage as dev dependencies and a `vitest.config.ts` with two projects/globs: unit (`**/*.unit.test.ts`, no setup) and integration (`**/*.integration.test.ts`, DB setup)
- [ ] 1.2 Add npm scripts: `test` (unit), `test:integration`, `test:all`, `test:watch`, `coverage`
- [ ] 1.3 Document the testing conventions (lanes, naming, seams) in AGENTS.md

## 2. Seams & fixtures

- [ ] 2.1 Mock language model fixture wrapping AI SDK `MockLanguageModel` — helpers to script text + tool-call sequences; inject at the same seam the real model uses
- [ ] 2.2 Fake `Gateway` driver implementing the normalized seam — records outbound, exposes `injectInbound(...)`; assertable outbound buffer
- [ ] 2.3 Injectable clock abstraction — thread `now()`/tick through scheduler, date-tagged memory facts, and the ticker; wire system clock in prod, fake in tests
- [ ] 2.4 Ephemeral Postgres fixture (Testcontainers `pgvector/pgvector:pg16`): provision, run Drizzle migrations, expose client, truncate-between-cases, teardown
- [ ] 2.5 Runtime test-composition helper that wires the fakes (mock model + fake gateway + fake clock + ephemeral DB) into the real runtime

## 3. Unit lane coverage

- [ ] 3.1 Prompt assembly + trailing non-user-message trimming (ends on a user message)
- [ ] 3.2 `send_message` elicitation/fallback logic (detect a turn that sent nothing → fallback path)
- [ ] 3.3 Memory fact parsing + date-tagging + forced-consolidation writer logic
- [ ] 3.4 Schedule/cron math (one-shot, interval, cron next-fire) under the fake clock
- [ ] 3.5 Gateway normalization + owner/auth identity matching

## 4. Integration lane coverage

- [ ] 4.1 Conversation store: seed messages, assert tsvector/FTS keyword recall against real Postgres
- [ ] 4.2 Memory store round-trip (write via the real writer API → recall) on real Postgres
- [ ] 4.3 Scheduler ticker: set schedule, advance clock, assert durable job dispatched (with anti-recursion guard)
- [ ] 4.4 Agent loop end-to-end with mock model + fake gateway: scripted tool call → dispatch → captured reply
- [ ] 4.5 Durable workflow step execution + idempotency (replayed step applies effect exactly once), within WDK test support

## 5. CI gate

- [ ] 5.1 GitHub Actions workflow: typecheck + unit + integration on push/PR, with a Postgres service container
- [ ] 5.2 Make CI block merge on failure; confirm evals are excluded from this gate

## 6. Eval harness

- [ ] 6.1 Define the eval case schema (setup: seeded memory/conversation/config; input message(s); grader references) and a loader for `evals/cases/**`
- [ ] 6.2 Harness runner: apply setup → drive the real loop against the fake gateway with a configurable model (default `claude-opus-4-8`) → capture messages, tool calls/results, telemetry
- [ ] 6.3 Programmatic grader interface + built-ins (tool-called, `sendCount`, gated-action-refused, op:// ref resolved, fact recalled)
- [ ] 6.4 LLM-as-judge grader: rubric runner using a distinct judge model; record judge model + rubric version with the verdict
- [ ] 6.5 N-run pass-rate scoring with per-case/dimension thresholds
- [ ] 6.6 Scorecard output (per-case + per-dimension pass rates, model, timestamp, cost) as a JSON artifact; run-to-run regression diff
- [ ] 6.7 Cost cap enforcement: stop-and-report when an eval run hits its budget
- [ ] 6.8 `npm run eval` entrypoint (select dataset/dimension, model, N)

## 7. Eval dataset (four dimensions)

- [ ] 7.1 `send_message` elicitation cases — assert user-facing reply went via `send_message`; flag `fallback_text`
- [ ] 7.2 Memory recall cases — seed facts, ask, assert retrieval + appropriate use (programmatic + judge)
- [ ] 7.3 Tool selection cases — durable job vs inline; schedule vs immediate; correct tool chosen
- [ ] 7.4 Security gating cases — hard-gated action gated/refused; non-owner ignored; blocklist respected

## 8. Observability integration (after `observability` lands)

- [ ] 8.1 Persist scorecards alongside trajectories and meter eval cost through the shared budget meter (fall back to file-only + local tally if absent)
- [ ] 8.2 Scheduled eval run delivering a scorecard summary to the owner over the gateway
