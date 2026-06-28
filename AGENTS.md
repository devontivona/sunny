# AGENTS.md — working notes for AI agents editing Sunny

Sunny is a self-hosted personal AI agent (iMessage-first). **Deploy/run details live
in [README.md](README.md) → "Running & deploying"** — this file is just conventions and
gotchas for editing the repo. Active/planned work lives in OpenSpec changes under
`openspec/changes/`.

## Commands

```bash
npm run typecheck     # tsc --noEmit (covers src/, workflows/, tests/, evals/)
npm run format        # prettier write (src/, server/, plugins/, workflows/)
npm run dev           # nitro dev (local, server only)
npm run dev:unified   # THE dev/serve command: Vite hosts Nitro + WDK (SPA HMR + server
                      #   hot-reload + WDK) on one port. This is what the `sunny` devbox runs.
npm run build         # nitro build → .output
npm test              # unit lane (pure logic; fast, no I/O)
npm run test:integration  # integration lane (real modules vs in-process PGlite)
npm run test:all      # unit + integration
npm run test:watch    # unit + integration in watch mode
npm run coverage      # informational coverage (not a merge gate)
npm run eval          # paid behavioral evals (real model) — on demand only
npm run dashboard:typecheck  # tsc for the React app (app/tsconfig.json)
npm run design:lint   # validate DESIGN.md (repo check; exit 1 on error)
npm run design:export # regenerate the committed app/theme.css from DESIGN.md
```

`server/` and `plugins/` are validated by the Nitro build, not by `tsc`.

## Testing & evals

Two layers split on the determinism/cost axis (design `testing-and-evals`):

- **Deterministic suite** — the merge gate. Runs on every change, no paid/external
  calls. Two lanes by filename:
  - **unit** (`*.unit.test.ts`, colocated in `src/`) — pure logic only: no network,
    no DB, no model.
  - **integration** (`*.integration.test.ts`) — real modules against an **in-process
    PGlite Postgres** (real Postgres in WASM — runs the actual Drizzle migrations incl.
    the tsvector/GIN FTS path). **No Docker.** Each test file gets a fresh in-memory DB
    via `createTestDb()` (`tests/db.ts`).
- **Evals** (`evals/**`, `npm run eval`) — drive the *real* loop against the fake
  gateway and grade behavior. Paid and non-deterministic, so **never on the gate**;
  run on demand.

**Seams (inject at the exact point production wires them — no test-only branches):**
- **Model** — `MockLanguageModelV3` from `ai/test` (scripts text + tool calls), injected
  via `createAgentRunner({ model })`. Production passes nothing → real `getModel(config)`.
- **Gateway** — `FakeGateway` (`tests/fakes/gateway.ts`) records outbound + injects inbound;
  no Sendblue.
- **Durable start** — a recording fake `start` injected via `createAgentRunner({ start })`;
  records `start_job` without launching a WDK job.
- **DB** — `createTestDb()` (in-process PGlite; honors `TEST_DATABASE_URL` for a real-PG
  escape hatch).
- **Time** — Vitest fake timers (`vi.useFakeTimers()` + `vi.setSystemTime()`); no
  production clock-injection.
- **Fixtures** — typed builders in `tests/factories.ts` (deterministic; **no faker**).
  Property-based tests (`fast-check`) cover the pure normalizers only.

### Drive full turns yourself — the loopback channel (don't ask the user to text)

To LIVE-test end to end (inbound → router → durable turn-run → delivery) without iMessage,
use the **loopback channel** instead of waiting on the user. It runs ALONGSIDE Sendblue
(`MultiChannelGateway` routes by thread: `loopback:` threads → loopback, everything else →
iMessage), so enabling it does **not** take iMessage down.

- Run with `SUNNY_TEST_CHANNEL=1` (+ `SUNNY_TEST_SECRET` in `.env`); the shared devbox is
  usually already in this mode (see the `sunny-devbox-worktree` memory).
- Driver: `set -a; . .env; set +a; SUNNY_BASE_URL=https://sunny.waywardlane.com \`
  `node scripts/test-channel.mjs "your message" [--say "deterministic reply"]`.
  `--say` runs the turn against a mock model (free, exact reply) via the `getTurnModel` seam;
  omit it for a real-model turn (prints Sunny's actual reply). Deterministic runs auto-use a
  FRESH unique thread — `mockSequenceModel` indexes its responses by assistant-message count in
  the prompt, so it only behaves on a thread with no history; real-model runs reuse the default
  thread for continuity. Don't `--say` on a `--thread` that already has history (it'll pick the
  wrong scripted response → may not deliver).
- Raw HTTP (header `x-test-secret`): `POST /test/inbound {text, threadId?, modelResponses?}`
  → `{cursor}`; `GET /test/outbound?threadId&afterSeq=cursor` → the captured replies.
- Source: `src/gateway/loopback.ts`, `multiChannel.ts`, `server/routes/test/*`.

### Run the durable workflow in tests — `@workflow/vitest` (Local World)

Durable workflows (`workflows/*.ts`) run END-TO-END in-process via `npm run test:workflow`
(`tests/workflow/*.workflow.test.ts`, the `@workflow/vitest` Local World — no Postgres). The
harness (`tests/workflow/harness.ts`) injects a test runtime on the `getRuntime` globalThis key
and mocks the model via the `getTurnModel`/`testModelResponses` seam. Use this — NOT a hand-
modeled step boundary — to test `runConversation`/jobs (delivery, mid-turn folding, exactly-once).

### Reproduce loop/prompt/model bugs from REAL conversations, not synthetic inputs

Agent-behavior bugs (delivery, elicitation, recovery, summarization) usually depend on
the *full* real context — token scale, the tool-call/reasoning trajectory, accumulated
scratch — that a hand-written input does not reproduce. A real case: a recovery-ghosting
bug returned empty **every time** on the captured 145k-token trajectory but **never** on
a minimal synthetic one, so a synthetic "regression test" guarded nothing. So when you
change the loop, a prompt, or model wiring, work fixture-first:

1. **Capture the offending turn from production** and save its input as a fixture —
   `langfuse-cli` (the `langfuse` skill: `npx langfuse-cli api traces get <id>`, base
   URL from `LANGFUSE_BASE_URL`) or query Postgres directly. Examples already in the
   repo: `evals/cases/fixtures/recoveryGhostTrajectory.json` (a full captured trajectory
   + scratch) and the `RealMiss` entries in `evals/cases/fixtures/realMisses.ts`.
2. **Write the test/eval against that fixture and watch it FAIL first** — reproduce the
   bug before touching code. A test you never saw red proves nothing.
3. Make the change; confirm the same test goes green. Keep the fixture as the guard.

Fixtures are the owner's own data, lightly redacted (see `realMisses.ts`). Trim oversized
tool-result payloads only *after* confirming the trimmed fixture still reproduces.

### Powered evals from real conversations (for stochastic behaviors)

A deterministic regression test works for a reproducible bug. But behaviors like
**elicitation** (does the model call `send_message` vs. leave the reply in scratch?) are
**~50/50 stochastic** — a single run proves nothing, and a 2–3 run A/B is noise. To move
these you need a *rate*, measured the same way Langfuse's eval structure does it:
**dataset item from a real trace → repeated experiment runs → score → compare runs.** Our
file-based harness mirrors that:

1. **Capture** the real turn from Postgres (the source of truth — verbatim `UIMessage`
   payloads with scratch + every tool part): `npx tsx evals/capture-turn.ts <threadId>
   [--input-id <msgId>]`. Use the `langfuse` skill to *find* which turns missed
   (`delivery-recovery` traces; their `langfuseSessionId` is the `threadId`).
2. **Seed it** into an eval case via `setup.fixtureTurns` (`evals/cases/elicitationReal.ts`).
   The harness replays it through the **real loop** (`runEvalCase`), so the model faces the
   exact production history (the scratch/`send_message` ratio that drives the behavior) —
   not a single stubbed model call.
3. **Run at high `-n`** (≥10) to get a stable pass-rate; `evals/run.ts` already does N-rep
   scoring + a `baseline.json` diff. **Establish the baseline rate first**, then A/B a change
   and compare rates — never read a 2-run result as signal.

Don't measure a prompt/loop change against synthetic elicitation cases — they pass while
production misses ~50%, the same blind spot as a synthetic regression test.

### Definition of done (every PR)

Before pushing, the deterministic suite must be green locally:

```bash
npm run typecheck && npm run test && npm run test:integration
```

(No Docker needed — integration uses in-process PGlite.) **After changing agent behavior**
(prompt, loop, tools, model, or memory wiring), add/extend an eval case for the affected
dimension, run `npm run eval`, and paste the scorecard delta in the PR.

What the *same PR* must include, by change type:

| Change | Required in the same PR |
|---|---|
| New/changed pure logic (loop helpers, auth, scheduler math, memory, prompt, config) | Unit test(s) covering the new/changed branches |
| New/changed DB query, schema, or migration | Integration test against PGlite (incl. recall/FTS if touched) |
| New/changed **agent behavior** (prompt, loop, tool, model, memory wiring) | Add/extend an eval case **and** run `npm run eval`, pasting the scorecard delta |
| New gateway/transport seam or normalization | Unit test (normalization) + integration test if it touches the store |
| Bug fix | A regression test that fails before the fix and passes after. For loop/prompt/model bugs, derive the fixture from a **real captured turn** (Langfuse/PG), not a synthetic input — see "Reproduce … from REAL conversations" |
| Docs/config-only, no behavior change | None — state "no behavior change" in the PR |

Checklist (mirrored in `.github/pull_request_template.md`):
- [ ] Deterministic suite green locally (`typecheck` + `test` + `test:integration`)
- [ ] New/changed behavior has matching unit/integration tests (see table)
- [ ] Bug fixes include a regression test (fails before, passes after)
- [ ] If **agent behavior** changed: eval case added/updated, `npm run eval` run, scorecard
      delta pasted — or "N/A: no behavior change"
- [ ] No silent coverage drop for the code this PR touches

## Layout

- `src/agent/` — turn loop, dispatcher (serialization/steering), tools (`send_message`,
  `start_job`, `schedule_*`, memory), model + prompt.
- `src/gateway/` — normalized `Gateway` seam, Sendblue driver, conversation store, auth.
- `src/memory/` — files-first memory soul (`~/.sunny/memory/`).
- `src/scheduler/` — schedules table + ~60s ticker.
- `src/db/` — Drizzle schema + client; migrations in `drizzle/`.
- `src/runtime.ts` — memoized startup (DB, migrations, memory, gateway, scheduler). The memo
  is pinned on `globalThis` so Vite's server-module re-eval on a back-end edit doesn't re-run
  startup. `SUNNY_DISABLE_SCHEDULER=1` skips the ticker (for a second instance during cutover).
- `server/` (Nitro routes: `/dashboard/api`, `/webhooks/sendblue`, `/health`),
  `plugins/startup.ts` (starts WDK world + runtime), `workflows/` (durable `"use workflow"` jobs).
- `vite.config.unified.ts` — the unified entry: `[nitro(), react(), tailwindcss(), workflow()]`.
  `nitro.config.ts` omits the `workflow/nitro` module under `NITRO_VITE=1` (the `workflow()`
  Vite plugin supplies it). Root `index.html` → `app/main.tsx` is the SPA entry (served at `/`).
- `app/` — the dashboard React/Vite SPA (its own `tsconfig.json`; `theme.css` generated from
  `DESIGN.md`, committed). `src/dashboard/` — read-only data layer + auth store + session
  signing. `server/routes/dashboard/api/[...].ts` — auth + JSON API; reuses `getRuntime()`
  (db + `gateway.send()`), so the owner approval prompt is an in-process send.

## Gotchas (hard-won)

- **devbox runs `dev:unified`** (Vite hosting Nitro) as the live `sunny` service. Front-end
  edits HMR; back-end (`server/`, `src/`) edits hot-reload the server (re-eval), and run
  migrations on the re-eval — be deliberate touching migrations/recovery code on the box.
  `app/` is excluded from Nitro's watcher; Vite handles its HMR.
- **Never edit an already-applied Drizzle migration** — the migrator silently skips it
  (keys by journal order, not file hash). Add a *new* migration instead.
- **WDK needs the Nitro build.** `"use workflow"` / `"use step"` are no-ops without it.
  Workflows live in `workflows/`; launch with `start()` from `workflow/api`; never call
  `start()` inside workflow context (wrap in a `"use step"`).
- **Anthropic prompts must end with a user message** (no assistant prefill). The recent
  window is insertion-ordered, so trim trailing non-user messages (assistant + tool) before
  generating.
- **`send_message` is the only user channel**; the model's plain text is private scratch.
  Sunny's past replies are reconstructed in history as `send_message` tool-call/result pairs
  (not plain assistant text) so its own track record reinforces "speaking == send_message".
  A telemetered fallback still delivers scratch if a turn sends nothing — watch logs for
  `delivered: 'fallback_text'` (means the elicitation slipped).
- **Postgres** is the dedicated `sunny-postgres` container on `:5544` — *not* the Supabase
  instance on the box. One DB holds messages/FTS/schedules/WDK state (D-DE4).
- **Secrets are env-only** (`.env`, gitignored). Never commit them. Non-secret config is
  `~/.sunny/config.json`.

## Observability

`devbox logs sunny -f`. Each turn logs `agent:loop: turn { steps, tools, sendCount,
delivered, tokensIn/Out, cachedIn, cacheWriteIn, ms }`. Set `SUNNY_LOG_CONTENT=1` to log message
text (dev only). Prompt caching is on (stable prefix marked `cacheControl: ephemeral`): a
multi-step turn shows `cachedIn > 0` (prefix re-read at ~0.1×); single-step turns show
`cacheWriteIn > 0` (the write).

### Langfuse / OTel telemetry — DURABLE PATH IS OFF (AI SDK v7)

After the v7 migration (`@ai-sdk/workflow` `WorkflowAgent`), **durable conversational turns + jobs do NOT emit OpenTelemetry/Langfuse spans**, and this is **intentional, not broken**: the durable `agent.stream(...)` calls set `telemetry: { isEnabled: false }` (see `workflows/{conversation,job,scheduledJob}.ts`). v7 dispatches agent telemetry from inside the WDK's `node:vm` realm, which the global `registerTelemetry` integration (in `src/observability/instrumentation.ts`) cannot reach, so any `isEnabled: true` there would produce zero spans while *looking* enabled. We disable it explicitly instead. Upstream: vercel/ai#12164 (draft in the change's `UPSTREAM-12164.md`).

- **Still works:** main-process AI-SDK telemetry — the delivery-recovery `generateText` pass and any in-process loop calls still emit to Langfuse (`registerTelemetry(new OpenTelemetry(...))` stays wired). The `TracePromotingSpanProcessor` reads the v7 attribute names (`ai.settings.context.*`, `gen_ai.agent.name`).
- **Workflow runs ARE still inspectable** via the WDK CLI — see "Inspect durable runs" below (this is the primary observability for the durable path, since Langfuse is off here).
- **To re-enable durable telemetry** (when Langfuse matters or upstream fixes it): pull the proven, shelved event-forwarding bridge — git branch `worktree-agent-af47988b13eeb3162` (a custom per-call `Telemetry` integration that forwards lifecycle events out of the VM via a journaled `'use step'`; journaling also dedupes replays). See the `migrate-ai-sdk-v7-workflow-agent` change notes.

### Inspect durable runs — `npx workflow inspect` (durable path's primary observability)

Since the durable path emits NO Langfuse spans (above), the WDK CLI is how you debug a **stuck or
failing turn/job**. The Postgres world is already wired via `WORKFLOW_TARGET_WORLD=@workflow/world-postgres`
in `.env`, so the CLI reads the live `sunny-postgres` `workflow.*` tables directly — just source `.env` first:

```bash
set -a; . ./.env; set +a
npx workflow inspect runs --status failed --limit 10  # recent failing runs (a STORM = many for one workflow)
npx workflow inspect run <runId>                      # the run's error.message + stack + input (incl. threadId) — decoded, no manual CBOR
npx workflow inspect steps -r <runId> [-d]            # which step failed; -d includes step input/output data
npx workflow inspect runs --web                       # local dashboard (also -i to paginate, --decrypt for encrypted fields)
```

A **retry storm** reads as a burst of `failed` runs for ONE workflow every few seconds (each run
exhausts its 3 step-retries, then the router starts a fresh run for the still-unanswered inbound).
`inspect run <id>` gives the real cause in one shot — e.g. a poisoned history surfaces as
``AI_APICallError: messages.N.content.M: `tool_use` ids must be unique`` failing the `doStreamStep`.
The offending thread is the run's `input.threadId`; from there read the window (`store.recentWindow`
/ the `messages` table) to find the bad turn row. Prefer this CLI over hand-querying the `workflow.*`
tables + decoding `*_cbor` columns (the error/IO live in CBOR, so raw SQL alone won't show them).
