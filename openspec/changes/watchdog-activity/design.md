# Design: watchdog-activity

## Context

`raceTurnWatchdog(returnValue, turnWatchdogMs)` (src/agent/turnWatchdog.ts) is a flat ref'd timer racing the run's `returnValue` — built for the hung-model-stream exposure (stalled Anthropic SSE; no client timeout survives WDK provider serialization). The 2026-07-12 incident: a healthy 25-step email sweep (dozens of himalaya IMAP calls, 5–60s each) was executed at exactly 600000ms while a bash step was mid-flight; every WDK step had completed cleanly. Separately, the abandoned run stayed "running" on the dashboard: `bridgeRunStream`'s `finally` — the only caller of `bus.finishTurn` — sits behind a `for(;;) reader.read()` loop, and a cancelled run's WDK stream does not necessarily close, so the read never resolves and the LiveBus entry never settles. And the user saw ~9 minutes of dead air: the translator (silence-default) declined at steps 16/19/22, and the model chose to grind a long research sweep inline rather than delegating.

Constraints: the watchdog must stay at the router level (provider-level timeouts don't survive WDK serialization); the run stream is the activity signal available in-process (`bridgeRunStream` already reads it — model deltas AND tool results at step boundaries flow through `writeToolResultsWithStepBoundary`); stream-quiet gaps during a single long tool call are bounded by that tool's own timeout (`bash` default 60s, model-chosen beyond that).

## Goals / Non-Goals

**Goals:**
- Hangs caught at the same speed as today (10 min of true silence); healthy turns run to the hard cap (60 min on the live host).
- Abandoned runs reach a terminal state everywhere: LiveBus settled, bridge reader torn down.
- The model prefers delegation for long sweeps; the translator stops going silent on long grinds.

**Non-Goals:**
- No per-tool timeouts or step-level deadlines (WDK owns step retry semantics).
- No dashboard UI changes (views already render settle events).
- No change to abandonment semantics (cancel → notify → retire, PR #29 double-text guard intact).

## Decisions

### D1 — Activity signal = the run stream the bridge already reads
`bridgeRunStream` reads every chunk of the run's output stream. A shared per-run `ActivityTracker` (a `touch()`ed timestamp) is updated on each chunk and consulted by the watchdog. This deliberately reuses the existing reader instead of adding a second stream consumer (the WDK stream contract expects one reader; a second would race it) or polling `workflow.workflow_steps` (couples the router to WDK-internal schema, adds DB load per turn). Trade-off: during a single silent tool call longer than `turnInactivityMs` with no parallel activity, the turn would be misjudged idle — acceptable because 10 minutes of stream silence requires the model to have explicitly passed `timeout_ms > 600000` on a lone bash call, and the failure mode equals today's behavior, not a regression.

### D2 — `raceTurnWatchdog(p, {inactivityMs, maxMs, lastActivityAt})` with a coarse check interval
The race generalizes: a repeating ~15s ref'd interval fires `TurnWatchdogTimeout` when `now - max(startedAt, lastActivityAt()) > inactivityMs` or `now - startedAt > maxMs`. The old lessons carry over verbatim: timers REF'D (a parked run may leave no other live handle), the abandoned promise DEFUSED. The old single-arg signature is kept as an overload so eval-side callers/tests migrate incrementally. `TurnWatchdogTimeout` gains a `reason: 'inactivity' | 'cap'` for the abandon log line.

### D3 — Abandon path settles the LiveBus and tears down the bridge (the dashboard bug)
`bridgeRunStream` returns a handle `{ cancel(): void }` (cancels the reader; the read loop exits via its catch → `finally` runs → typing stopped, `bus.finishTurn` called). `abandonHungTurn` calls it after `run.cancel()`, and ALSO calls `bus.finishTurn(runId, 'errored')` directly (belt-and-suspenders — the bridge's own settle may land later or never). `LiveBus.finishTurn` is made explicitly idempotent (second settle is a no-op) so the two paths can't double-fire events. The bridge's bounded `Promise.race(returnValue, turnWatchdogMs + 15s)` backstop stays (covers non-watchdog stream wedges) but its bound now derives from the hard cap.

### D4 — Instruction changes: delegate the sweep; translator must not stay silent
- `agent/builtin/skills/delegation/SKILL.md` (§1 "when to delegate") + the conversational prompt: a task needing MANY sequential tool calls against one source (mailbox sweep, batch research, per-item processing) is a delegation case — spawn a subagent with a complete brief and tell the user it's underway; keep the conversational turn short and steerable. This is builtin content, so the deploy updates every machine.
- `src/agent/translator.ts` compose prompt: add a hard rule — beyond N steps since the last update (N=10), silence is not an acceptable output; send one short concrete status line. The parse/decline machinery is untouched.

### D5 — Config: `turnInactivityMs`, default 600000
New optional config knob beside `turnWatchdogMs`; default equals the old flat budget, so a machine that never touches config gets today's hang-detection latency with the new won't-kill-healthy-work behavior. `turnWatchdogMs` doc comment updated to "hard cap".

## Risks / Trade-offs

- **[A lone >10-min silent tool call gets abandoned]** → equal to today's behavior; the model can parallelize or delegate; threshold is config.
- **[Double settle of LiveBus]** → `finishTurn` idempotence; unit test covers abandon-then-bridge-settle ordering both ways.
- **[Interval granularity (~15s) delays the fire slightly]** → irrelevant at 10-min thresholds.
- **[Translator becomes chatty]** → the rule only overrides silence past 10 quiet steps; normal turns unaffected.

## Migration Plan

Code-only change; no data migration. Deploy = merge + restart (config knob optional). Rollback = revert.

## Open Questions

_None._
